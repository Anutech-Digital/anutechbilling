// @vitest-environment jsdom
/**
 * R-377 — "Pay now ₹X" on the accepted confirmation, plus R-376(b) tax heads and the
 * included-support line on the public accept page.
 *
 * The amount is pinned to what the pay route charges (lib/checkout/quote-order.ts):
 * quoteInstalments().firstGross on a split quote, quote.amount otherwise.
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { quoteInstalments } from "@/lib/billing/instalments";
import { acceptedPayNow, type AcceptedPayQuote } from "./accepted-pay";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/razorpay/checkout-client", () => ({ loadRazorpayCheckout: vi.fn() }));

import { QuoteAcceptView, type PublicQuote, type PublicLine } from "./quote-accept-view";

afterEach(cleanup);

const yearly: AcceptedPayQuote = {
  amount: 28320, subtotal: 24000, discount_pct: 0, tax_rate: 18,
  billing_cycle: "yearly", currency: "INR", payment_status: "awaiting", invoice_id: null,
};
const quarterly: AcceptedPayQuote = { ...yearly, billing_cycle: "quarterly" };

describe("acceptedPayNow — amount", () => {
  it("one-time (yearly) quote → the full amount", () => {
    const r = acceptedPayNow({ quote: yearly, firstCommitment: "annual", payOnline: true, hasUpi: false });
    expect(r).toEqual({ amount: 28320, instalment: null });
  });

  it("split quote → firstGross, the same figure the pay route charges", () => {
    const engine = quoteInstalments({
      cycle: "quarterly", termTaxable: 24000, termGross: 28320, taxRate: 18, lineCommitment: "annual",
    });
    const r = acceptedPayNow({ quote: quarterly, firstCommitment: "annual", payOnline: true, hasUpi: false });
    expect(r?.amount).toBe(engine!.firstGross);
    expect(r?.amount).toBe(7080);
    expect(r?.instalment?.count).toBe(engine!.count);
  });

  it("flex (monthly commitment) → the stored per-month amount, no split", () => {
    const r = acceptedPayNow({
      quote: { ...yearly, billing_cycle: "monthly", amount: 2360, subtotal: 2000 },
      firstCommitment: "monthly", payOnline: false, hasUpi: true,
    });
    expect(r).toEqual({ amount: 2360, instalment: null });
  });
});

describe("acceptedPayNow — when it is hidden", () => {
  it("no Razorpay and no UPI → null", () => {
    expect(acceptedPayNow({ quote: yearly, firstCommitment: "annual", payOnline: false, hasUpi: false })).toBeNull();
  });
  it("UPI alone is enough", () => {
    expect(acceptedPayNow({ quote: yearly, firstCommitment: "annual", payOnline: false, hasUpi: true })).not.toBeNull();
  });
  it.each([
    ["received", null], ["invoiced", null], ["partial", null], ["awaiting", "INV-1"],
  ])("already paid / invoiced (%s, invoice %s) → null", (payment_status, invoice_id) => {
    expect(acceptedPayNow({
      quote: { ...yearly, payment_status, invoice_id }, firstCommitment: "annual", payOnline: true, hasUpi: true,
    })).toBeNull();
  });
  it("foreign-currency quote → null", () => {
    expect(acceptedPayNow({ quote: { ...yearly, currency: "USD" }, firstCommitment: "annual", payOnline: true, hasUpi: true })).toBeNull();
  });
  it("zero amount → null", () => {
    expect(acceptedPayNow({ quote: { ...yearly, amount: 0, subtotal: 0 }, firstCommitment: "annual", payOnline: true, hasUpi: true })).toBeNull();
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
