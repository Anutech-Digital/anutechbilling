/**
 * R-2588: "Apply advance ₹X" on an expense bill recorded WITH TDS, when the vendor's advance
 * carried TDS (R-1916): the button shows the full gross the database applies (₹1,00,000), not the
 * bill less its TDS (₹90,000) — the advance's TDS is credited on the bill.
 */
import { describe, expect, it } from "vitest";
import { advanceTdsTake, billAdvanceView } from "./vendor-account";

const bill = (over: Record<string, unknown> = {}) => ({
  amount: 100_000, paid: false, tds_amount: 10_000, reconciled_txn_id: null, category: "Professional Fees",
  payment_method: null, prepaid_advance_id: null, advance_applied: 0, paid_amount: 0,
  vendor_id: "v1", vendor_name: "Sharma Design Studio", ...over,
});
const adv = (over: Record<string, unknown> = {}) => ({
  id: "a1", total_amount: 100_000, consumed_amount: 0, closed_at: null, vendor_id: "v1", vendor_name: "Sharma Design Studio",
  category: "Professional Fees", tds_amount: 10_000, paid_date: "2026-10-05", ...over,
});

describe("billAdvanceView with an advance that carried TDS (R-2588)", () => {
  it("₹1,00,000 bill with TDS ₹10,000 + ₹1,00,000 advance with TDS ₹10,000 → Apply advance ₹1,00,000", () => {
    expect(billAdvanceView(bill(), [adv()]).canApply).toBe(100_000);
  });
  it("a plain advance (no TDS) → ₹90,000, as before", () => {
    expect(billAdvanceView(bill(), [adv({ total_amount: 90_000, tds_amount: 0 })]).canApply).toBe(90_000);
  });
  it("a bank part already paid (its TDS went with it) → no credit", () => {
    expect(billAdvanceView(bill({ paid_amount: 20_000 }), [adv()]).canApply).toBe(70_000);
  });
  it("the share matches the SQL test's part apply: ₹50,000 of the advance credits ₹5,000", () => {
    expect(advanceTdsTake(100_000, 90_000, 10_000, 10_000, 100_000, 50_000)).toEqual({ take: 50_000, credit: 5_000 });
    expect(advanceTdsTake(50_000, 45_000, 5_000, 10_000, 100_000)).toEqual({ take: 50_000, credit: 5_000 });
  });
});
