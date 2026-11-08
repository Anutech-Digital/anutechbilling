/** R-2588: the Apply advance toast says the advance's TDS was credited (not taken twice). */
import { describe, expect, it } from "vitest";
import { applyAdvanceWords } from "./vendor-advance";

describe("applyAdvanceWords (R-2588)", () => {
  it("names the TDS credited from the advance", () => {
    const s = applyAdvanceWords({ expense_id: "E1", bill_no: "SD-1", vendor_name: "Sharma Design Studio", applied: 100_000, still_due: 0, settled: true, advance_left: 0, tds_credit: 10_000 });
    expect(s).toContain("bill SD-1 is paid");
    expect(s).toContain("TDS ₹10,000 was already deducted on the advance — not taken again on bill SD-1.");
  });
  it("says nothing about TDS for a plain advance", () => {
    const s = applyAdvanceWords({ expense_id: "E1", bill_no: null, vendor_name: "Verma", applied: 30_000, still_due: 20_000, settled: false, advance_left: 0 });
    expect(s).not.toContain("TDS");
  });
});
