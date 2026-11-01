// R-2324 — Reconcile → vendor → "Select bills oldest first, up to the bank amount".
// Owner case (R-2319): one distributor payment covers 40–54 COGS bills; ticking each one by hand
// is not practical, and the exact-sum preselect finds nothing when the bank amount is not the
// exact total of all open bills.
import { describe, it, expect } from "vitest";
import { allocateOldestFirst, itemKey, pickOldestUpTo, preselect, type VendorOpenItem } from "./debit-pay-for";

const bill = (n: number, date: string, due: number, o: Partial<VendorOpenItem> = {}): VendorOpenItem => ({
  source: "vendor_bill", doc_id: `B${n}`, bill_no: `RD-${n}`, doc_date: date, due_date: null, category: "COGS-M365",
  total: due, amount_due: due, gst: 0, tds_base: 0, tds_amount: 0, tds_section: null, can_part: true, in_run: null, ...o,
});
const noTds = () => new Map<string, number>();

describe("pickOldestUpTo", () => {
  // 54 bills of ₹10,000 each, dated one day apart, listed newest first
  const many = Array.from({ length: 54 }, (_, i) => bill(i + 1, `2026-08-${String((i % 28) + 1).padStart(2, "0")}`, 10000))
    .map((b, i) => ({ ...b, doc_date: new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10) }))
    .reverse();

  it("owner case: ₹4,05,000 over 54 open bills → the 41 oldest; the 41st part-paid", () => {
    expect(preselect(many, 405000, noTds).keys).toEqual([]); // the old exact-sum rule finds nothing
    const keys = pickOldestUpTo(many, 405000, noTds);
    expect(keys).toHaveLength(41);
    expect(keys[0]).toBe(itemKey(many[many.length - 1])); // oldest first
    const picked = many.filter((i) => keys.includes(itemKey(i)));
    const a = allocateOldestFirst(picked, 405000, noTds());
    expect(a.left).toBe(0);
    expect([...a.cashByKey.values()].filter((v) => v === 5000)).toHaveLength(1);
  });

  it("bank amount at least the whole due → every open bill", () => {
    expect(pickOldestUpTo(many, 600000, noTds)).toHaveLength(54);
  });

  it("skips a bill in a payment run and a payment already recorded", () => {
    const items = [
      bill(1, "2026-08-01", 1000, { in_run: "RUN-1" }),
      bill(2, "2026-08-02", 1000, { source: "recorded_payment" }),
      bill(3, "2026-08-03", 1000),
      bill(4, "2026-08-04", 1000),
    ];
    expect(pickOldestUpTo(items, 1500, noTds)).toEqual([itemKey(items[2]), itemKey(items[3])]);
  });

  it("a bill that cannot be part-paid and does not fit is passed over, not starved", () => {
    const items = [bill(1, "2026-08-01", 6000), bill(2, "2026-08-02", 6000, { source: "expense", can_part: false }), bill(3, "2026-08-03", 6000)];
    const keys = pickOldestUpTo(items, 9000, noTds);
    expect(keys).toEqual([itemKey(items[0]), itemKey(items[2])]);
  });

  it("TDS planned on the bills is counted: cash needed is after TDS", () => {
    const items = [bill(1, "2026-08-01", 10000), bill(2, "2026-08-02", 10000), bill(3, "2026-08-03", 10000)];
    const tds = (bs: readonly VendorOpenItem[]) => new Map(bs.map((b) => [itemKey(b), 1000]));
    // ₹18,000 = two bills net of ₹1,000 TDS each
    expect(pickOldestUpTo(items, 18000, tds)).toHaveLength(2);
  });
});
