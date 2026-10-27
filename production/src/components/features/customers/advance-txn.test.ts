/**
 * R-2033: on the customer Transactions tab an R-1863/R-2023 advance holder quote read
 * "Quote · ₹0 · Accepted" (and a cancelled one "Quote · ₹0 · Rejected"). It is the
 * customer's advance: "Advance · ₹4,00,000 · Available ₹4,00,000" / "Used" / "Cancelled".
 */
import { describe, it, expect } from "vitest";
import { advanceTxnView, isPaymentTxn } from "./advance-txn";

const holder = (over: Record<string, unknown> = {}) => ({
  id: "Q-F588-27-0046", plan: "Advance on account", amount: 0, invoice_id: null, line_items: [],
  status: "accepted", payment_amount: 400000, ...over,
});
const pay = { id: "p1", quote_id: "Q-F588-27-0046", status: "received", amount: 400000 };

describe("R-2033 advanceTxnView", () => {
  it("an open advance reads Advance · ₹4,00,000 · Available ₹4,00,000 (owner's Bharat case)", () => {
    const v = advanceTxnView(holder(), [pay], [{ amount: 400000, status: "open", source_payment_id: "p1", source_quote_id: null }]);
    expect(v).toEqual({ type: "Advance", amount: 400000, status: "Available ₹4,00,000" });
  });

  it("partly used shows what is left; all used reads Used", () => {
    expect(advanceTxnView(holder(), [pay], [
      { amount: 150000, status: "open", source_payment_id: "p1", source_quote_id: null },
      { amount: 250000, status: "used", source_payment_id: "p1", source_quote_id: null },
    ])?.status).toBe("Available ₹1,50,000");
    expect(advanceTxnView(holder(), [pay], [{ amount: 400000, status: "used", source_payment_id: "p1", source_quote_id: null }])?.status).toBe("Used");
  });

  it("credit rows of another advance do not count", () => {
    expect(advanceTxnView(holder(), [pay], [{ amount: 9000, status: "open", source_payment_id: "other", source_quote_id: "Q-X" }])?.status).toBe("Used");
  });

  it("a rejected (cancelled) holder reads Cancelled", () => {
    const v = advanceTxnView(holder({ id: "Q-F588-27-0045", status: "rejected" }), [], []);
    expect(v).toEqual({ type: "Advance", amount: 400000, status: "Cancelled" });
  });

  it("a normal quote is left alone", () => {
    expect(advanceTxnView(holder({ plan: "Google Workspace", amount: 5000 }), [], [])).toBeNull();
  });

  it("Advance rows count under Payments, not Quotes", () => {
    expect(isPaymentTxn("Advance")).toBe(true);
    expect(isPaymentTxn("Payment")).toBe(true);
    expect(isPaymentTxn("Refund")).toBe(true);
    expect(isPaymentTxn("Quote")).toBe(false);
  });
});
