// R-1564 — which sheet an invoice's Record payment opens, and what the result toast says
// about where an instalment payment went.
import { describe, it, expect } from "vitest";
import { invoicePaymentRoute, instalmentPaymentLines, oldestInstalmentPerSubscription } from "./instalment-payment";

const inv = { id: "INV-1", amount: 2360, net_payable: 2360, paid_amount: 0, status: "pending" };
const idle = { loading: false, failed: false, data: null };

describe("invoicePaymentRoute", () => {
  it("own quote → the quote-keyed sheet", () => {
    expect(invoicePaymentRoute(inv, { ...idle, data: { id: "Q" } }, idle).kind).toBe("quote");
  });

  it("instalment → this invoice's own amount and what is already in (₹1,000 of ₹2,360 → ₹1,360 due)", () => {
    const r = invoicePaymentRoute({ ...inv, paid_amount: 1000 }, idle, { ...idle, data: { quoteId: "Q-SUB" } });
    expect(r).toEqual({ kind: "instalment", quoteId: "Q-SUB", expected: 2360, alreadyReceived: 1000, due: 1360 });
  });

  it("never 'loading' once both lookups answered — the R-1564 hang", () => {
    expect(invoicePaymentRoute(inv, idle, idle).kind).toBe("none");
    expect(invoicePaymentRoute(inv, { ...idle, failed: true }, idle).kind).toBe("error");
    expect(invoicePaymentRoute(inv, { ...idle, loading: true }, idle).kind).toBe("loading");
    expect(invoicePaymentRoute(inv, idle, { ...idle, loading: true }).kind).toBe("loading");
  });

  it("an instalment answer wins over a slow / failed quote lookup", () => {
    expect(invoicePaymentRoute(inv, { ...idle, failed: true }, { ...idle, data: { quoteId: "Q" } }).kind).toBe("instalment");
  });

  it("subscription with no quote → says why (§24), never a sheet", () => {
    const r = invoicePaymentRoute(inv, idle, { ...idle, data: { quoteId: null } });
    expect(r.kind).toBe("none");
    if (r.kind === "none") expect(r.detail).toMatch(/link the subscription to its quote/);
  });
});

describe("oldestInstalmentPerSubscription (multi-invoice list)", () => {
  it("one open instalment per subscription — the oldest by term, then period", () => {
    expect(oldestInstalmentPerSubscription([
      { invoice_id: "I-3", subscription_id: "s1", term_start: "2026-07-01", period_index: 3 },
      { invoice_id: "I-2", subscription_id: "s1", term_start: "2026-07-01", period_index: 2 },
      { invoice_id: "I-N1", subscription_id: "s1", term_start: "2027-07-01", period_index: 1 },
      { invoice_id: "J-1", subscription_id: "s2", term_start: "2026-01-01", period_index: 1 },
      { invoice_id: null, subscription_id: "s3", term_start: "2026-01-01", period_index: 1 },
    ]).sort()).toEqual(["I-2", "J-1"]);
  });
});

describe("instalmentPaymentLines", () => {
  it("part payment → what is still due on THIS invoice", () => {
    expect(instalmentPaymentLines({ invoice_id: "INV-1", applied: 1000, invoice_paid: false, invoice_due_after: 1360 }))
      .toEqual(["INV-1: ₹1,360 still due."]);
  });

  it("overpayment → paid, the extra on the next open instalment, the rest kept for the next one", () => {
    expect(instalmentPaymentLines({
      invoice_id: "INV-2", applied: 2360, invoice_paid: true, invoice_due_after: 0,
      also_applied: [{ invoice_id: "INV-3", applied: 640, invoice_paid: false }],
      advance_left: 280,
    })).toEqual([
      "INV-2 is now paid in full.",
      "₹640 more went to INV-3.",
      "₹280 is kept for this subscription — it is adjusted on the next instalment invoice automatically.",
    ]);
  });
});
