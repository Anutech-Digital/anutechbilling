/**
 * R-2698 — per-employee PF basis: capped at the month's statutory ceiling (default) or on the
 * full Basic + DA (the employee/company chose to contribute above the ceiling).
 */
import { describe, it, expect } from "vitest";
import { computePf, pfWage, pfWageCeiling } from "./pf";

describe("computePf — capped (default) vs full Basic + DA", () => {
  it("capped: Basic 30,000 in Nov 2026 → 12% of the month's ceiling", () => {
    const c = computePf(30_000, true, "2026-11");
    expect(c.base).toBe(pfWageCeiling("2026-11"));
    expect(c.employee).toBe(Math.round(pfWageCeiling("2026-11") * 0.12));
    expect(c.employer).toBe(c.employee);
  });

  it("capped: Basic 15,000 → 1,800 each side", () => {
    const c = computePf(15_000, true, "2026-11");
    expect(c.employee).toBe(1_800);
    expect(c.employer).toBe(1_800);
  });

  it("full Basic + DA: no cap — 12% of the whole wage", () => {
    const c = computePf(40_000, true, "2026-11", { capped: false });
    expect(c.base).toBe(40_000);
    expect(c.employee).toBe(4_800);
    expect(c.employer).toBe(4_800);
    expect(c.ceiling).toBe(pfWageCeiling("2026-11")); // still reported, for the EPS cap / ECR
  });

  it("full wage below the ceiling is the same as capped", () => {
    expect(computePf(12_000, true, "2026-11", { capped: false })).toEqual(computePf(12_000, true, "2026-11"));
  });

  it("PF off → zero, whatever the basis", () => {
    const off = computePf(40_000, false, "2026-11", { capped: false });
    expect(off.employee).toBe(0);
    expect(off.employer).toBe(0);
    expect(off.applicable).toBe(false);
  });

  it("part-month salary prorates Basic + DA: 24,000 of a 60,000 month, Basic 40,000 → PF wage 16,000", () => {
    const w = pfWage({ gross: 24_000, basic: 40_000, da: 0, monthlyGross: 60_000 });
    expect(w.base).toBe(16_000);
    expect(computePf(w.base, true, "2026-11", { capped: false }).employee).toBe(1_920);
  });

  it("full month, or paid above the monthly gross → whole Basic + DA (ratio never above 1)", () => {
    expect(pfWage({ gross: 60_000, basic: 40_000, da: 0, monthlyGross: 60_000 }).base).toBe(40_000);
    expect(pfWage({ gross: 70_000, basic: 40_000, da: 0, monthlyGross: 60_000 }).base).toBe(40_000);
    expect(pfWage({ gross: 60_000, lopAmount: 6_000, basic: 40_000, da: 0, monthlyGross: 60_000 }).base).toBe(36_000);
  });

  it("zero wage → zero", () => {
    expect(computePf(0, true, "2026-11", { capped: false }).employee).toBe(0);
  });
});
