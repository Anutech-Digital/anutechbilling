/**
 * R-2588: a ₹1,00,000 bill settled from an advance that carried TDS ₹10,000 (R-1916) has its own
 * TDS moved onto the advance (tds_amount 0, vendor_advance_applications.tds_credit 10,000). The
 * year total still counts it, but NOT as "paid without TDS" — else the next bill would ask for a
 * catch-up TDS on money whose TDS was already deducted.
 */
import { describe, expect, it } from "vitest";
import { vendorFyTdsTotal } from "./vendor-tds-fy";

const exp = (id: string, amount: number, tds = 0, sec: string | null = null) =>
  ({ id, amount, gst_paid: 0, tds_amount: tds, tds_section: sec });

describe("vendorFyTdsTotal (R-2588)", () => {
  it("a bill whose TDS was credited from the advance is not 'without TDS'", () => {
    const fy = vendorFyTdsTotal({
      section: "194JB", expenses: [exp("E1", 100_000, 0, "194J"), exp("E2", 20_000)], cogsBills: [], cogsTds: [],
      advanceTdsCredits: [{ expense_id: "E1", tds_credit: 10_000 }],
    });
    expect(fy).toEqual({ base: 120_000, baseWithoutTds: 20_000 });
  });

  it("without the credit rows the same bill counts as without TDS (the old reading)", () => {
    const fy = vendorFyTdsTotal({ section: "194JB", expenses: [exp("E1", 100_000, 0, "194J")], cogsBills: [], cogsTds: [] });
    expect(fy).toEqual({ base: 100_000, baseWithoutTds: 100_000 });
  });
});
