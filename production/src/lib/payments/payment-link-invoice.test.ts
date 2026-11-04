/**
 * R-2415 — one Razorpay payment link per open invoice / statement total (pure half).
 * The IO half (create / reuse / cancel against Razorpay, mocked) is payment-link-invoice.server.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  INVOICE_LINK_PURPOSE,
  cardLinkNotice,
  invoiceLinkAllocations,
  invoiceLinkKey,
  invoiceLinkRequest,
  isInvoiceLinkPayment,
  linkAmountFor,
  parsePaymentLinkPaid,
  planInvoiceLink,
  withCardPayLink,
  type LinkAllocation,
} from "./payment-link";

const CUST = "11111111-2222-3333-4444-555555555555";
const ALLOC: LinkAllocation[] = [{ invoice_id: "INV-2026-27-0042", quote_id: "Q-0042", amount: 11_800 }];

describe("linkAmountFor — the seam R-2417 changes", () => {
  it("asks for the bill amount only (the fee is R-2417's job)", () => {
    expect(linkAmountFor({ billAmount: 11_800 })).toBe(11_800);
  });
  it("whole rupees", () => {
    expect(linkAmountFor({ billAmount: 11_800.4 })).toBe(11_800);
  });
});

describe("invoiceLinkKey", () => {
  it("one key per invoice, one per customer statement", () => {
    expect(invoiceLinkKey("invoice", "INV-1")).toBe("invoice:INV-1");
    expect(invoiceLinkKey("statement", CUST)).toBe(`statement:${CUST}`);
  });
});

describe("planInvoiceLink — reuse, replace, create", () => {
  const now = Date.parse("2026-11-03T14:00:00Z");
  const live = { status: "active", amount: 11_800, allocations: ALLOC, created_at: "2026-11-01T10:00:00Z", expires_at: null };

  it("no link yet → create", () => {
    expect(planInvoiceLink(null, { amount: 11_800, allocations: ALLOC }, now)).toEqual({ action: "create" });
  });
  it("opening Send reminder again for the same bill reuses the same link", () => {
    expect(planInvoiceLink(live, { amount: 11_800, allocations: ALLOC }, now)).toEqual({ action: "reuse" });
  });
  it("the amount changed (part paid / credit note) → cancel the old link, make a new one", () => {
    const want = { amount: 6_800, allocations: [{ ...ALLOC[0], amount: 6_800 }] };
    expect(planInvoiceLink(live, want, now)).toEqual({ action: "replace", reason: "amount changed" });
  });
  it("same total but other bills on the statement → replace", () => {
    const want = { amount: 11_800, allocations: [{ invoice_id: "INV-2", quote_id: "Q-2", amount: 11_800 }] };
    expect(planInvoiceLink(live, want, now)).toEqual({ action: "replace", reason: "bills changed" });
  });
  it("a link about to expire is replaced, not sent", () => {
    const soon = { ...live, expires_at: "2026-11-04T10:00:00Z" };
    expect(planInvoiceLink(soon, { amount: 11_800, allocations: ALLOC }, now)).toEqual({ action: "replace", reason: "expiring" });
  });
  it("another person is making it right now → wait (never a second link)", () => {
    const making = { ...live, status: "creating", created_at: "2026-11-03T13:59:30Z" };
    expect(planInvoiceLink(making, { amount: 11_800, allocations: ALLOC }, now)).toEqual({ action: "wait" });
  });
  it("a 'creating' row left behind by a crash (2+ min) is replaced", () => {
    const stuck = { ...live, status: "creating", created_at: "2026-11-03T13:50:00Z" };
    expect(planInvoiceLink(stuck, { amount: 11_800, allocations: ALLOC }, now)).toEqual({ action: "replace", reason: "stuck" });
  });
});

describe("invoiceLinkAllocations — which bills may carry a Razorpay link", () => {
  const inv = (id: string, extra: Partial<{ customer_id: string; quote_id: string | null; currency: string | null; status: string }> = {}) => ({
    id, customer_id: CUST, quote_id: `Q-${id}`, currency: "INR", status: "overdue", ...extra,
  });
  const quotes = [{ id: "Q-A", invoice_id: "A" }, { id: "Q-B", invoice_id: "B" }];

  it("an open INR invoice with its own quote → one allocation for its due", () => {
    const out = invoiceLinkAllocations({
      customerId: CUST,
      lines: [{ kind: "invoice", id: "A", amountDue: 5_000 }],
      invoices: [inv("A")],
      quotes,
    });
    expect(out).toEqual({ ok: true, allocations: [{ invoice_id: "A", quote_id: "Q-A", amount: 5_000 }] });
  });
  it("statement: every bill, amounts as listed", () => {
    const out = invoiceLinkAllocations({
      customerId: CUST,
      lines: [{ kind: "invoice", id: "A", amountDue: 5_000 }, { kind: "invoice", id: "B", amountDue: 2_000 }],
      invoices: [inv("A"), inv("B")],
      quotes,
    });
    expect(out.ok && out.allocations.map((a) => a.amount)).toEqual([5_000, 2_000]);
  });
  it("a subscription line has no invoice to book on → no Razorpay link", () => {
    const out = invoiceLinkAllocations({ customerId: CUST, lines: [{ kind: "subscription", id: "s1", amountDue: 900 }], invoices: [], quotes });
    expect(out).toEqual({ ok: false, reason: "not_invoice" });
  });
  it("an instalment invoice (no quote of its own) → no link", () => {
    const out = invoiceLinkAllocations({
      customerId: CUST, lines: [{ kind: "invoice", id: "C", amountDue: 900 }], invoices: [inv("C", { quote_id: "Q-YEAR" })],
      quotes: [{ id: "Q-YEAR", invoice_id: null }],
    });
    expect(out).toEqual({ ok: false, reason: "no_own_quote" });
  });
  it("a bill in another currency → no link", () => {
    const out = invoiceLinkAllocations({
      customerId: CUST, lines: [{ kind: "invoice", id: "A", amountDue: 100 }], invoices: [inv("A", { currency: "USD" })], quotes,
    });
    expect(out).toEqual({ ok: false, reason: "non_inr" });
  });
  it("another customer's invoice is never put on this link", () => {
    const out = invoiceLinkAllocations({
      customerId: CUST, lines: [{ kind: "invoice", id: "A", amountDue: 100 }], invoices: [inv("A", { customer_id: "other" })], quotes,
    });
    expect(out).toEqual({ ok: false, reason: "not_open" });
  });
  it("nothing due → no link", () => {
    expect(invoiceLinkAllocations({ customerId: CUST, lines: [], invoices: [], quotes })).toEqual({ ok: false, reason: "nothing_due" });
  });
});

describe("invoiceLinkRequest — Razorpay sends nothing itself", () => {
  const body = invoiceLinkRequest({
    rowId: "0e9d0c0a-1b2c-4d5e-8f90-a1b2c3d4e5f6",
    tenantId: "t-1",
    scope: "invoice",
    label: "INV-2026-27-0042",
    amount: 11_800,
    sellerName: "Acme IT",
    customerName: "Buyer Pvt Ltd",
    customerEmail: "a@b.in",
    customerPhone: "+919800000000",
    nowMs: Date.parse("2026-11-03T14:00:00Z"),
  });
  it("paise, INR, our row id as the reference", () => {
    expect(body.amount).toBe(1_180_000);
    expect(body.currency).toBe("INR");
    expect(body.reference_id).toBe("0e9d0c0a-1b2c-4d5e-8f90-a1b2c3d4e5f6");
  });
  it("no SMS, no email, no Razorpay reminders — we send the reminder", () => {
    expect(body.notify).toEqual({ sms: false, email: false });
    expect(body.reminder_enable).toBe(false);
  });
  it("tags the link so payment.captured leaves it to payment_link.paid", () => {
    expect(body.notes).toEqual({ tenant_id: "t-1", purpose: INVOICE_LINK_PURPOSE, link_row: "0e9d0c0a-1b2c-4d5e-8f90-a1b2c3d4e5f6" });
    expect(body.description).toBe("Acme IT — invoice INV-2026-27-0042");
  });
  it("expires in 30 days", () => {
    expect(body.expire_by).toBe(Math.floor(Date.parse("2026-12-03T14:00:00Z") / 1000));
  });
  it("statement wording", () => {
    const s = invoiceLinkRequest({
      rowId: "r", tenantId: "t", scope: "statement", label: "3 bills", amount: 5, sellerName: "Acme", customerName: null,
      customerEmail: null, customerPhone: null, nowMs: 0,
    });
    expect(s.description).toBe("Acme — statement, 3 bills");
    expect(s.customer).toEqual({});
  });
});

describe("isInvoiceLinkPayment", () => {
  it("reads our tag from the payment or the order notes", () => {
    expect(isInvoiceLinkPayment({ purpose: INVOICE_LINK_PURPOSE }, undefined)).toBe(true);
    expect(isInvoiceLinkPayment(undefined, { purpose: INVOICE_LINK_PURPOSE })).toBe(true);
    expect(isInvoiceLinkPayment({ quoteId: "Q-1" }, {})).toBe(false);
  });
});

describe("parsePaymentLinkPaid", () => {
  const ok = {
    event: "payment_link.paid",
    payload: {
      payment_link: { entity: { id: "plink_ABC123def", status: "paid", amount: 1_180_000, amount_paid: 1_180_000, notes: { tenant_id: "t" } } },
      payment: { entity: { id: "pay_XYZ789", amount: 1_180_000, currency: "INR", status: "captured", method: "upi", order_id: "order_1" } },
    },
  };
  it("takes the link id, payment id and the paise actually captured", () => {
    expect(parsePaymentLinkPaid(ok)).toEqual({
      linkId: "plink_ABC123def", paymentId: "pay_XYZ789", paidPaise: 1_180_000, currency: "INR", method: "upi", orderId: "order_1",
      notes: { tenant_id: "t" },
    });
  });
  it("refuses a body without a captured payment", () => {
    const noPay = { ...ok, payload: { payment_link: ok.payload.payment_link } };
    expect(parsePaymentLinkPaid(noPay)).toBeNull();
    const failed = { ...ok, payload: { ...ok.payload, payment: { entity: { ...ok.payload.payment.entity, status: "failed" } } } };
    expect(parsePaymentLinkPaid(failed)).toBeNull();
    expect(parsePaymentLinkPaid(null)).toBeNull();
  });
});

describe("withCardPayLink — the link goes next to the UPI link", () => {
  const url = "https://rzp.io/i/abc123";
  it("right after the UPI line", () => {
    const msg = "Hi Rahul\n\nPay by UPI (open on your phone): upi://pay?pa=x\n\nPlease ignore this if already paid.\n\n— Acme team";
    expect(withCardPayLink(msg, url)).toBe(
      "Hi Rahul\n\nPay by UPI (open on your phone): upi://pay?pa=x\nPay by card / UPI / net banking: https://rzp.io/i/abc123\n\nPlease ignore this if already paid.\n\n— Acme team",
    );
  });
  it("no UPI line → before 'Please ignore'", () => {
    const msg = "Hi\n\n• Invoice A: ₹5,000\n\nPlease ignore this if already paid.\n\n— Acme team";
    expect(withCardPayLink(msg, url)).toBe(
      "Hi\n\n• Invoice A: ₹5,000\n\nPay by card / UPI / net banking: https://rzp.io/i/abc123\n\nPlease ignore this if already paid.\n\n— Acme team",
    );
  });
  it("AI draft with only a sign-off → before the sign-off", () => {
    expect(withCardPayLink("Hi, ₹5,000 is pending.\n— Acme team", url)).toBe(
      "Hi, ₹5,000 is pending.\nPay by card / UPI / net banking: https://rzp.io/i/abc123\n— Acme team",
    );
  });
  it("nothing to anchor on → at the end; never twice", () => {
    expect(withCardPayLink("Hi", url)).toBe("Hi\n\nPay by card / UPI / net banking: https://rzp.io/i/abc123");
    const once = withCardPayLink("Hi", url);
    expect(withCardPayLink(once, url)).toBe(once);
  });
});

describe("cardLinkNotice — §24: why there is no card link, and the fix", () => {
  it("Razorpay not connected → Settings → Integrations", () => {
    const n = cardLinkNotice("not_configured");
    expect(n?.text).toMatch(/Razorpay/);
    expect(n?.action).toEqual({ label: "Open Settings", href: "/settings?tab=integrations" });
  });
  it("a subscription / instalment bill says the UPI link still works", () => {
    expect(cardLinkNotice("not_invoice")?.text).toMatch(/UPI/);
    expect(cardLinkNotice("no_own_quote")?.text).toMatch(/UPI/);
  });
  it("nothing due → no notice", () => {
    expect(cardLinkNotice("nothing_due")).toBeNull();
  });
});
