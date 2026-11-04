/** R-2095: TDS paise rounding (₹297 vs ₹298) — see tds-rounding.ts. */
import { describe, it, expect } from "vitest";
import { tdsWithRounding, tdsOnlyReceipt } from "./tds-rounding";

describe("R-2095 TDS ₹1 rounding on a balance payment", () => {
  it("bank + TDS at rate ₹1 short of the balance → TDS takes the ₹1 (297 → 298)", () => {
    expect(tdsWithRounding({ tdsAtRate: 297, remaining: 17_820, bank: 17_522, credit: 0, bankTyped: true })).toBe(298);
  });
  it("₹1 over → TDS ₹1 less", () => {
    expect(tdsWithRounding({ tdsAtRate: 298, remaining: 17_820, bank: 17_523, credit: 0, bankTyped: true })).toBe(297);
  });
  it("₹2 or more apart → the rate's TDS (a real part payment / overpayment)", () => {
    expect(tdsWithRounding({ tdsAtRate: 297, remaining: 17_820, bank: 17_521, credit: 0, bankTyped: true })).toBe(297);
  });
  it("bank amount not typed → unchanged", () => {
    expect(tdsWithRounding({ tdsAtRate: 297, remaining: 17_820, bank: 17_522, credit: 0, bankTyped: false })).toBe(297);
  });
});

describe("R-2095 TDS-only balance receipt is not bank money", () => {
  it("₹0 in bank + TDS → method other, no bank account, named TDS deducted by customer", () => {
    expect(tdsOnlyReceipt({ method: "bank_transfer", bankAccountId: "hdfc", bank: 0, tdsActive: true, notes: "TDS 194J @ 10%" }))
      .toEqual({ method: "other", bankAccountId: null, notes: "TDS deducted by customer · TDS 194J @ 10%", tdsOnly: true });
  });
  it("money in bank → unchanged", () => {
    expect(tdsOnlyReceipt({ method: "bank_transfer", bankAccountId: "hdfc", bank: 100, tdsActive: true, notes: null }))
      .toEqual({ method: "bank_transfer", bankAccountId: "hdfc", notes: null, tdsOnly: false });
  });
});
