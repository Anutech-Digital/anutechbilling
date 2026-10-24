// @vitest-environment jsdom
/**
 * R-377 — "Pay now ₹X" on the accepted confirmation, plus R-376(b) tax heads and the
 * included-support line on the public accept page.
 *
 * The amount is pinned to what the pay route charges (lib/checkout/quote-order.ts): both read
 * quoteDueNow (R-1613) — instalment 1 on a split quote, total − money received otherwise.
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { quoteInstalments } from "@/lib/billing/instalments";
import { quoteDueNow, type QuoteDueNowFields } from "@/lib/payments/quote-due-now";
import { acceptedPayNow } from "./accepted-pay";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/razorpay/checkout-client", () => ({ loadRazorpayCheckout: vi.fn() }));

import { QuoteAcceptView, type PublicQuote, type PublicLine } from "./quote-accept-view";

afterEach(cleanup);

const yearly: QuoteDueNowFields = {
  amount: 28320, subtotal: 24000, discount_pct: 0, tax_rate: 18,
  billing_cycle: "yearly", currency: "INR", payment_status: "awaiting", invoice_id: null,
  line_items: [{ qty: 10, rate: 2400, commitment: "annual_yearly" }],
};
const quarterly: QuoteDueNowFields = { ...yearly, billing_cycle: "quarterly" };
const pay = (q: QuoteDueNowFields, o: { payOnline?: boolean; hasUpi?: boolean; received?: number } = {}) =>
  acceptedPayNow({ due: quoteDueNow(q, o.received ?? 0), payOnline: o.payOnline ?? true, hasUpi: o.hasUpi ?? false });

describe("acceptedPayNow — amount", () => {
  it("one-time (yearly) quote → the full amount", () => {
    expect(pay(yearly)).toEqual({ amount: 28320, instalment: null, alreadyPaid: 0 });
  });

  it("split quote → firstGross, the same figure the pay route charges", () => {
    const engine = quoteInstalments({
      cycle: "quarterly", termTaxable: 24000, termGross: 28320, taxRate: 18, lineCommitment: "annual",
    });
    const r = pay(quarterly);
    expect(r?.amount).toBe(engine!.firstGross);
    expect(r?.amount).toBe(7080);
    expect(r?.instalment?.count).toBe(engine!.count);
  });

  it("flex (monthly commitment) → the stored per-month amount, no split", () => {
    const r = pay({ ...yearly, billing_cycle: "monthly", amount: 2360, subtotal: 2000, line_items: [{ commitment: "monthly" }] }, { payOnline: false, hasUpi: true });
    expect(r).toEqual({ amount: 2360, instalment: null, alreadyPaid: 0 });
  });

  it("R-1613: part-paid quote → only what is still due (₹28,320 − ₹10,000 = ₹18,320)", () => {
    expect(pay({ ...yearly, payment_status: "partial" }, { received: 10000 })).toEqual({ amount: 18320, instalment: null, alreadyPaid: 10000 });
  });
});

describe("acceptedPayNow — when it is hidden", () => {
  it("no Razorpay and no UPI → null", () => {
    expect(pay(yearly, { payOnline: false, hasUpi: false })).toBeNull();
  });
  it("UPI alone is enough", () => {
    expect(pay(yearly, { payOnline: false, hasUpi: true })).not.toBeNull();
  });
  it.each([
    ["received", null, 0], ["invoiced", null, 0], ["partial", null, 28320], ["awaiting", "INV-1", 0],
  ])("already paid / invoiced (%s, invoice %s, received ₹%i) → null", (payment_status, invoice_id, received) => {
    expect(pay({ ...yearly, payment_status, invoice_id }, { hasUpi: true, received })).toBeNull();
  });
  it("split quote whose first instalment is paid → null", () => {
    expect(pay({ ...quarterly, payment_status: "partial" }, { received: 7080 })).toBeNull();
  });
  it("foreign-currency quote → null", () => {
    expect(pay({ ...yearly, currency: "USD", exchange_rate: 83 }, { hasUpi: true })).toBeNull();
  });
  it("zero amount → null", () => {
    expect(pay({ ...yearly, amount: 0, subtotal: 0 }, { hasUpi: true })).toBeNull();
  });
});

const pq = (over: Partial<PublicQuote> = {}): PublicQuote => ({
  id: "Q-R377", status: "accepted", customer_name: "Test Co", subtotal: 24000, discount_pct: 0,
  tax_rate: 18, amount: 28320, expires_date: null, notes: null, billing_cycle: "yearly",
  currency: "INR", exchange_rate: null, ...over,
});
const lines: PublicLine[] = [{ id: "l1", name: "Workspace Starter", qty: 10, rate: 2400, commitment: "annual_yearly" }];
const upi = { dataUrl: "data:image/png;base64,AA==", vpa: "shop@upi", amount: 28320 };

function view(props: Partial<React.ComponentProps<typeof QuoteAcceptView>> = {}) {
  return render(
    <QuoteAcceptView quote={pq()} lineItems={lines} token="t" tenantName="ANUTECH"
      tenantGstin={null} tenantEmail={null} {...props} />,
  );
}

describe("accepted screen", () => {
  it("shows Pay now ₹X (and the UPI QR) when the tenant can be paid", () => {
    view({ payOnline: true, upiQr: upi, acceptedPay: { amount: 28320, instalment: null } });
    expect(screen.getByRole("button", { name: /Pay now · ₹28,320/ })).toBeTruthy();
    expect(screen.getByText("Pay by UPI")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/will reach out with/);
  });

  it("split quote: the CTA carries firstGross, not the term", () => {
    view({
      quote: pq({ billing_cycle: "quarterly" }), payOnline: true,
      acceptedPay: { amount: 7080, instalment: { count: 4, cycle: "quarterly" } },
    });
    expect(screen.getByRole("button", { name: /Pay now · ₹7,080/ })).toBeTruthy();
    expect(document.body.textContent).toMatch(/instalment 1 of 4/);
  });

  it("no payment setup → today's text, no Pay now", () => {
    view({ payOnline: false, upiQr: null, acceptedPay: null });
    expect(screen.queryByRole("button", { name: /Pay now/ })).toBeNull();
    expect(document.body.textContent).toMatch(/will reach out with\s+payment instructions/);
  });

  it("UPI-only tenant whose QR disagrees with the Pay-now figure → nothing offered", () => {
    view({ payOnline: false, upiQr: { ...upi, amount: 100 }, acceptedPay: { amount: 28320, instalment: null } });
    expect(screen.queryByTestId("accepted-pay")).toBeNull();
    expect(document.body.textContent).toMatch(/will reach out with/);
  });
});

describe("review screen — tax heads and support line (R-376b)", () => {
  it("inter-state → one IGST row", () => {
    view({ quote: pq({ status: "sent" }), interState: true });
    expect(document.body.textContent).toMatch(/IGST \(18%\)/);
    expect(document.body.textContent).not.toMatch(/CGST/);
  });

  it("intra-state → CGST + SGST halves", () => {
    view({ quote: pq({ status: "sent" }), interState: false });
    const t = document.body.textContent ?? "";
    expect(t).toMatch(/CGST \(9%\)₹2,160/);
    expect(t).toMatch(/SGST \(9%\)₹2,160/);
    expect(t).not.toMatch(/IGST/);
  });

  it("shows the included-support line when given", () => {
    view({
      quote: pq({ status: "sent" }),
      supportLine: { text: "Support: Free — Included", detail: "Email support · First response in 24h" },
    });
    expect(screen.getByTestId("included-support").textContent).toMatch(/Support: Free — Included/);
  });

  it("no support line → nothing rendered", () => {
    view({ quote: pq({ status: "sent" }) });
    expect(screen.queryByTestId("included-support")).toBeNull();
  });
});

/* R-1613: the page shows the figure the order charges — never the total on a part-paid quote. */
describe("pay figure = what is due now (R-1613)", () => {
  const sentQ = (over: Partial<PublicQuote> = {}) => pq({ status: "sent", subtotal: 600, amount: 708, ...over });
  const line600: PublicLine[] = [{ id: "l1", name: "Workspace Starter", qty: 1, rate: 600, commitment: "annual_yearly" }];
  const dueOf = (over: Partial<QuoteDueNowFields>, received: number) => quoteDueNow({
    amount: 708, subtotal: 600, discount_pct: 0, tax_rate: 18, billing_cycle: "yearly", currency: "INR",
    payment_status: "partial", invoice_id: null, line_items: [{ qty: 1, rate: 600, commitment: "annual_yearly" }], ...over,
  }, received);

  it("review screen, part-paid ₹708 with ₹400 received → 'Pay online now · ₹308' and says why", () => {
    view({ quote: sentQ(), lineItems: line600, payOnline: true, dueNow: dueOf({}, 400) });
    expect(screen.getByRole("button", { name: /Pay online now · ₹308/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /₹708/ })).toBeNull();
    expect(screen.getByTestId("already-paid").textContent).toMatch(/₹400 of ₹708 is already received/);
  });

  it("accepted screen, part-paid → Pay now ₹308 and the QR for ₹308", () => {
    const due = dueOf({}, 400);
    const acceptedPay = acceptedPayNow({ due, payOnline: true, hasUpi: true });
    view({ quote: pq({ subtotal: 600, amount: 708 }), lineItems: line600, payOnline: true, dueNow: due, acceptedPay, upiQr: { ...upi, amount: 308 } });
    expect(screen.getByRole("button", { name: /Pay now · ₹308/ })).toBeTruthy();
    expect(screen.getByText("Pay by UPI")).toBeTruthy();
  });

  it("fully paid → 'Paid', no Pay button, no QR", () => {
    view({ quote: sentQ(), lineItems: line600, payOnline: true, dueNow: dueOf({ payment_status: "received" }, 708), upiQr: null });
    expect(screen.getByRole("heading", { name: "Paid" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Pay/ })).toBeNull();
    expect(screen.queryByText("Pay by UPI")).toBeNull();
  });

  it("USD billed monthly → no ₹ instalment and no Pay button anywhere", () => {
    const usd = dueOf({ currency: "USD", exchange_rate: 83, billing_cycle: "monthly", subtotal: 83000, amount: 97940, payment_status: "none",
      line_items: [{ qty: 10, rate: 8300, commitment: "annual_yearly" }] }, 0);
    expect(usd).toMatchObject({ state: "due", inr: false, amount: 98.33 });
    view({
      quote: sentQ({ currency: "USD", exchange_rate: 83, billing_cycle: "monthly", subtotal: 83000, amount: 97940 }),
      lineItems: [{ id: "l1", name: "Workspace Starter", qty: 10, rate: 8300, commitment: "annual_yearly" }],
      payOnline: false, dueNow: usd,
    });
    expect(screen.queryByRole("button", { name: /Pay/ })).toBeNull();
    // ₹97,940 ÷ 12 = 8,161.67 / ₹8,162 — the rupee instalment, with any sign in front.
    expect(document.body.textContent).not.toMatch(/8,161\.67|8,162/);
    expect(document.body.textContent).toMatch(/98\.33/); // the dollar instalment the PDF prints
  });
});
