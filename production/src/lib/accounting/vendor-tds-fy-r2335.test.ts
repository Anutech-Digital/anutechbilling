/**
 * R-2335: the vendor's year total for the TDS threshold counts COGS bills too.
 * Owner's case: a COGS vendor (Mehta Cloud) already paid ₹40,000 (value before GST) this FY on
 * COGS bills; the next ₹70,000 bill must show 194C as due (₹1,10,000 > ₹1,00,000), not "within
 * the limit" — before R-2335 only expense bills were counted, so the year showed ₹0 + ₹70,000.
 */
import { describe, expect, it } from "vitest";
import { vendorFyTdsTotal } from "./vendor-tds-fy";
import { tdsDecision } from "./tds-deductor";

const exp = (id: string, amount: number, gst = 0, tds = 0, sec: string | null = null) =>
  ({ id, amount, gst_paid: gst, tds_amount: tds, tds_section: sec });
const bill = (id: string, subtotal: number, paid: number, extra: Partial<{ currency: string; fx_rate: number }> = {}) =>
  ({ id, subtotal, paid_amount: paid, ...extra });

describe("vendorFyTdsTotal (R-2335)", () => {
  it("counts a paid COGS bill's value before GST — the owner's ₹40,000 → 194C due on the next ₹70,000", () => {
    const fy = vendorFyTdsTotal({ section: "194C", expenses: [], cogsBills: [bill("B1", 40_000, 47_200)], cogsTds: [] });
    expect(fy).toEqual({ base: 40_000, baseWithoutTds: 40_000 });
    const d = tdsDecision({ section: "194C", base: 70_000, fyBaseSoFar: fy.base, fyBaseWithoutTds: fy.baseWithoutTds, pan: "AAKFM2335A" });
    expect(d.applies).toBe(true);
    expect(d.tds).toBe(1_400);
    // and the ₹40,000 paid without TDS is caught up
    expect(d.catchUpTds).toBe(800);
  });

  it("a COGS bill with services TDS counts in the base but not in 'without TDS'", () => {
    const fy = vendorFyTdsTotal({
      section: "194C", expenses: [exp("E1", 11_800, 1_800)],
      cogsBills: [bill("B1", 10_000, 11_800), bill("B2", 5_000, 5_900)],
      cogsTds: [{ vendor_bill_id: "B1", tds_amount: 200, tds_section: "194C" }],
    });
    expect(fy).toEqual({ base: 25_000, baseWithoutTds: 15_000 });
  });

  it("an unpaid COGS bill is not counted (Reconcile / Bills Pay add the bill being paid themselves)", () => {
    expect(vendorFyTdsTotal({ section: "194C", expenses: [], cogsBills: [bill("B1", 40_000, 0)], cogsTds: [] }))
      .toEqual({ base: 0, baseWithoutTds: 0 });
  });

  it("R-2338: 194J(a) / 194J(b) share one limit; a bill whose TDS was another family (194Q) is left out", () => {
    const fy = vendorFyTdsTotal({
      section: "194JB", expenses: [exp("E1", 20_000, 0, 2_000, "194J")],
      cogsBills: [bill("B1", 30_000, 30_000), bill("B2", 9_000, 9_000)],
      cogsTds: [
        { vendor_bill_id: "B1", tds_amount: 600, tds_section: "194JA" },
        { vendor_bill_id: "B2", tds_amount: 9, tds_section: "194Q" },
      ],
    });
    expect(fy).toEqual({ base: 50_000, baseWithoutTds: 0 });
  });

  it("excludes the expense being edited and the bills named, and converts a foreign-currency bill to rupees", () => {
    const fy = vendorFyTdsTotal({
      section: "194C", expenses: [exp("E1", 5_000), exp("E2", 7_000)], excludeId: "E2",
      cogsBills: [bill("B1", 100, 100, { currency: "USD", fx_rate: 84 }), bill("B2", 1_000, 1_000)], excludeBillIds: ["B2"],
      cogsTds: [],
    });
    expect(fy).toEqual({ base: 13_400, baseWithoutTds: 13_400 });
  });
});
