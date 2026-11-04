/**
 * R-2430 — Reconcile from Zoho's opening-invoice path: two DIFFERENT bank lines whose statement
 * reference is a placeholder (000000000000000) settling the SAME opening invoice must be two
 * receipts. record_multi_invoice_payment replays on invoice + reference, so each line sends its own
 * reference: a real UTR as it is, a placeholder → BANK-<bank line id>.
 */
import { describe, it, expect } from "vitest";
import { openingPaymentArgs } from "./zoho-bulk-book";

const base = { customerId: "c-1", invoiceId: "OPN-7", received: 5000, receivedOn: "2026-05-12", tdsAmount: 0, tdsRatePct: null, tdsSection: null };

describe("openingPaymentArgs reference (R-2430)", () => {
  it("two zero-ref lines on one opening invoice send two different references", () => {
    const a = openingPaymentArgs({ ...base, transactionId: "t-1", reference: "000000000000000" }, "acct-1");
    const b = openingPaymentArgs({ ...base, transactionId: "t-2", reference: "000000000000000" }, "acct-1");
    expect(a.p_reference).toBe("BANK-t-1");
    expect(b.p_reference).toBe("BANK-t-2");
  });
  it("the same line again sends the same reference (a retry replays, booked once)", () => {
    const i = { ...base, transactionId: "t-1", reference: "000000000000000" };
    expect(openingPaymentArgs(i, "acct-1").p_reference).toBe(openingPaymentArgs(i, "acct-1").p_reference);
  });
  it("a real UTR is sent as it is", () => {
    expect(openingPaymentArgs({ ...base, transactionId: "t-1", reference: "HDFCN52026051912345678" }, "acct-1").p_reference)
      .toBe("HDFCN52026051912345678");
  });
});
