/** R-2428 — owner's case: ₹24,358 record, full & final ₹19,056 paid → LOP ₹5,302 makes net = paid. */
import { describe, it, expect } from "vitest";
import { netAfterLop, lopForNet, lopProblem } from "./salary-lop";

const keshavApr = { gross: 24358, incentive: 0, advance_recovered: 0, tds: 0, pf: 0, esi: 0, other_deduction: 0, paid_amount: 19056 };

describe("R-2428 salary LOP", () => {
  it("LOP for the amount actually paid", () => {
    expect(lopForNet(keshavApr, 19056)).toBe(5302);
    expect(netAfterLop(keshavApr, 5302)).toBe(19056);
    expect(lopProblem(keshavApr, 5302, "Left mid-April")).toBeNull();
  });

  it("with deductions and incentive", () => {
    const p = { gross: 30000, incentive: 2000, advance_recovered: 1000, tds: 500, pf: 1800, esi: 0, other_deduction: 0, paid_amount: 0 };
    expect(netAfterLop(p, 0)).toBe(28700);
    expect(lopForNet(p, 20000)).toBe(8700);
    expect(netAfterLop(p, 8700)).toBe(20000);
  });

  it("refuses below what was paid, above gross, and without a reason", () => {
    expect(lopProblem(keshavApr, 6000, "x x x")).toMatch(/already paid ₹19056/);
    expect(lopProblem(keshavApr, 30000, "x x x")).toMatch(/more than the gross/);
    expect(lopProblem(keshavApr, 5302, " ")).toMatch(/Say why/);
    expect(lopForNet(keshavApr, 30000)).toBeNull();
  });
});
