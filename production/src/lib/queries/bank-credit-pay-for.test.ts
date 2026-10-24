/* R-1838 — exactly what reaches the two server paths. The money work is proven by
   supabase/tests/r1838_bank_credit_pay_for.test.sql; this pins the arguments. */
import { describe, it, expect } from "vitest";
import { newSaleArgs, payItemArgs } from "./bank-credit-pay-for";

describe("R-1838 reconcile_bank_credit_to_item arguments", () => {
  it("an invoice is paid by its invoice id (never also by the quote)", () => {
    const a = payItemArgs({ transactionId: "t", quoteId: "Q-1", invoiceId: "INV-1", tdsAmount: 200, tdsRatePct: 2, createSubscription: null, subStart: null, subRenewal: null });
    expect(a).toMatchObject({ p_quote_id: null, p_invoice_id: "INV-1", p_tds_amount: 200, p_tds_rate_pct: 2, p_tds_section: "194J" });
  });
  it("renewal / add seats: no TDS → no rate or section; no subscription choice", () => {
    const a = payItemArgs({ transactionId: "t", quoteId: "Q-REN", invoiceId: null, tdsAmount: 0, tdsRatePct: 2, createSubscription: null, subStart: "2026-10-20", subRenewal: null });
    expect(a).toMatchObject({ p_quote_id: "Q-REN", p_tds_amount: 0, p_tds_rate_pct: null, p_tds_section: null, p_create_subscription: null, p_sub_start: null });
  });
  it("fresh quote ticked carries the dates; unticked carries none", () => {
    const base = { transactionId: "t", quoteId: "Q-N", invoiceId: null, tdsAmount: 0, tdsRatePct: null, subStart: "2026-10-20", subRenewal: "2027-10-31" };
    expect(payItemArgs({ ...base, createSubscription: true })).toMatchObject({ p_create_subscription: true, p_sub_start: "2026-10-20", p_sub_renewal: "2027-10-31" });
    expect(payItemArgs({ ...base, createSubscription: false })).toMatchObject({ p_create_subscription: false, p_sub_start: null, p_sub_renewal: null });
  });
});

describe("R-1838 reconcile_bank_credit_new_sale arguments", () => {
  it("seats × unit price per line, whole rupees, with each line's term", () => {
    const a = newSaleArgs({
      transactionId: "t", customerId: "c1", createSubscription: true, subStart: "2026-10-21", subRenewal: null, tdsAmount: 0, tdsRatePct: null,
      lines: [{ itemId: "GW", name: " GWS Plus ", qty: 5, rate: 3000, cost: 2500, cycle: "annual_yearly", perSeat: true }],
    });
    expect(a.p_lines).toEqual([{ id: "line-1", item_id: "GW", name: "GWS Plus", qty: 5, rate: 3000, cost: 2500, commitment: "annual_yearly" }]);
    expect(a).toMatchObject({ p_customer_id: "c1", p_create_subscription: true, p_sub_start: "2026-10-21", p_tds_amount: 0 });
  });
});
