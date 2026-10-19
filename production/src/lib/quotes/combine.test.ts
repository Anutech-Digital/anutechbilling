import { describe, expect, it } from "vitest";
import {
  combineBlockReason,
  combineMismatch,
  combinedTotal,
  showInCombineList,
  type CombinableQuote,
} from "./combine";

const q = (over: Partial<CombinableQuote> = {}): CombinableQuote => ({
  id: "Q-1",
  status: "accepted",
  invoice_id: null,
  superseded_by: null,
  payment_status: "awaiting",
  approval_status: "not_required",
  is_renewal: false,
  is_extension: false,
  is_add_seats: false,
  credit_activated_at: null,
  discount_pct: 0,
  currency: "INR",
  exchange_rate: 1,
  tax_rate: 18,
  billing_cycle: "yearly",
  is_one_off: false,
  payment_terms_days: null,
  amount: 1180,
  ...over,
});

describe("R-1527 showInCombineList", () => {
  it("lists accepted quotes with no invoice and not replaced", () => {
    expect(showInCombineList(q())).toBe(true);
  });
  it("never lists an invoiced quote (an issued invoice is never combined)", () => {
    expect(showInCombineList(q({ invoice_id: "INV-1" }))).toBe(false);
  });
  it("never lists a replaced or not-accepted quote", () => {
    expect(showInCombineList(q({ superseded_by: "Q-9" }))).toBe(false);
    expect(showInCombineList(q({ status: "sent" }))).toBe(false);
  });
});

describe("R-1527 combineBlockReason", () => {
  it("a clean accepted, unpaid quote can be combined", () => {
    expect(combineBlockReason(q())).toBeNull();
    expect(combineBlockReason(q({ payment_status: "none" }))).toBeNull();
    expect(combineBlockReason(q({ approval_status: "approved" }))).toBeNull();
  });
  it.each([
    [{ invoice_id: "INV-7" }, /INV-7/],
    [{ superseded_by: "Q-9" }, /Replaced by Q-9/],
    [{ status: "sent" }, /accepted/],
    [{ payment_status: "partial" }, /Money is already recorded/],
    [{ payment_status: "received" }, /Money is already recorded/],
    [{ approval_status: "pending" }, /approval/],
    [{ approval_status: "rejected" }, /refused/],
    [{ is_renewal: true }, /Renewal/],
    [{ is_extension: true }, /Renewal/],
    [{ is_add_seats: true }, /add-seats/],
    [{ credit_activated_at: "2026-10-01T00:00:00Z" }, /credit/],
    [{ discount_pct: 5 }, /discount/],
  ] as const)("refuses %o", (over, msg) => {
    expect(combineBlockReason(q(over))).toMatch(msg);
  });
});

describe("R-1527 combineMismatch", () => {
  const anchor = q({ id: "Q-A" });
  it("the anchor itself and an identical quote match", () => {
    expect(combineMismatch(undefined, q())).toBeNull();
    expect(combineMismatch(anchor, anchor)).toBeNull();
    expect(combineMismatch(anchor, q({ id: "Q-B" }))).toBeNull();
  });
  it.each([
    [{ currency: "USD" }, /currency/],
    [{ exchange_rate: 83 }, /currency/],
    [{ tax_rate: 0 }, /GST \(0%\)/],
    [{ billing_cycle: "monthly" }, /monthly/],
    [{ is_one_off: true }, /One-time/],
    [{ payment_terms_days: 15 }, /payment terms/],
  ] as const)("refuses a quote with %o", (over, msg) => {
    expect(combineMismatch(anchor, q({ id: "Q-B", ...over }))).toMatch(msg);
  });
});

describe("R-1527 combinedTotal", () => {
  it("adds the quotes' totals", () => {
    expect(combinedTotal([q({ amount: 11800 }), q({ amount: 5901 }), q({ amount: 1179 })])).toBe(18880);
    expect(combinedTotal([q({ amount: null })])).toBe(0);
  });
});
