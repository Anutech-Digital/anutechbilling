/**
 * R-2702 — a Zoho invoice adjustment imported as its own line ({kind: "adjustment"}, no GST, outside the
 * taxable value) is never a share of the HSN table (GSTR-1 Table 12): the taxable value is split over the
 * sold lines only.
 */
import { describe, it, expect } from "vitest";
import { docHsnLines } from "./gstr1";

describe("R-2702 docHsnLines leaves Zoho's adjustment line out", () => {
  const none = new Map<string, string | null>();

  it("a +₹500 adjustment line takes no taxable share", () => {
    const out = docHsnLines(100000, [
      { name: "Seats", hsn: "998315", qty: 100, rate: 1000 },
      { name: "Adjustment", hsn: null, qty: 1, rate: 500, kind: "adjustment" },
    ], none);
    expect(out).toEqual([{ hsn: "998315", description: "Seats", taxable: 100000 }]);
  });

  it("two sold lines still split by weight; the adjustment is ignored", () => {
    const out = docHsnLines(100000, [
      { name: "Seats", hsn: "998315", qty: 1, rate: 90000 },
      { name: "Fee", hsn: "998599", qty: 1, rate: 10000 },
      { name: "Adjustment", qty: 1, rate: 2500, kind: "adjustment" },
    ], none);
    expect(out.map((l) => [l.hsn, l.taxable])).toEqual([["998315", 90000], ["998599", 10000]]);
  });
});
