import { describe, it, expect } from "vitest";
import { computePf, pfWageCeiling, pfEpsCap, pfWage, PF_WAGE_CEILINGS } from "./pf";

describe("PF wage = Basic + DA", () => {
  it("uses Basic + DA, not the gross", () => {
    const w = pfWage({ gross: 40_000, basic: 16_000, da: 2_000 });
    expect(w).toMatchObject({ base: 18_000, assumed: false });
    expect(computePf(w.base, true, "2026-10").employee).toBe(2_160);
  });
  it("prorates Basic + DA by the same loss-of-pay ratio as the gross", () => {
    expect(pfWage({ gross: 30_000, lopAmount: 3_000, basic: 15_000, da: 0 }).base).toBe(13_500);
  });
  it("no Basic on the master → whole earned gross, flagged as assumed", () => {
    const w = pfWage({ gross: 30_000, lopAmount: 1_000, basic: null });
    expect(w).toMatchObject({ base: 29_000, assumed: true });
    expect(w.note).toMatch(/Basic not set/);
  });
  it("a zero Basic is a real value, not a missing one", () => {
    expect(pfWage({ gross: 30_000, basic: 0 })).toMatchObject({ base: 0, assumed: false });
  });
});

describe("PF wage ceiling by salary month", () => {
  it("₹15,000 till September 2026, ₹25,000 from the October 2026 salary", () => {
    expect(pfWageCeiling("2026-09")).toBe(15_000);
    expect(pfWageCeiling("2026-09-30")).toBe(15_000);
    expect(pfWageCeiling("2026-10")).toBe(25_000);
    expect(pfWageCeiling("2026-10-01")).toBe(25_000);
    expect(pfWageCeiling("2027-03")).toBe(25_000);
  });

  it("an old month keeps its old ceiling — filed ECRs never move", () => {
    const aug = computePf(30_000, true, "2026-08");
    expect(aug).toMatchObject({ ceiling: 15_000, base: 15_000, employee: 1_800, employer: 1_800, total: 3_600 });
    const oct = computePf(30_000, true, "2026-10");
    expect(oct).toMatchObject({ ceiling: 25_000, base: 25_000, employee: 3_000, employer: 3_000, total: 6_000 });
  });

  it("below the ceiling the whole wage is the base; not covered → zero", () => {
    expect(computePf(20_000, true, "2026-10")).toMatchObject({ base: 20_000, employee: 2_400 });
    expect(computePf(20_000, false, "2026-10")).toMatchObject({ applicable: false, employee: 0, employer: 0 });
  });

  it("EPS cap is 8.33% of the ceiling", () => {
    expect(pfEpsCap("2026-09")).toBe(1_250);
    expect(pfEpsCap("2026-10")).toBe(2_083);
  });

  it("the table is ordered oldest → newest so lookups are monotonic", () => {
    for (let i = 1; i < PF_WAGE_CEILINGS.length; i++) expect(PF_WAGE_CEILINGS[i].from > PF_WAGE_CEILINGS[i - 1].from).toBe(true);
  });
});
