/**
 * R-2773 (Hitesh 14 Nov, feedback 043e6753): "naya employee add karte waqt monthly Gross daalne par
 * Basic 100% kyun, jabki company policy Basic 50% hai?" — the Add employee form left Basic empty,
 * Save wrote basic_monthly = null and payroll took the whole gross as Basic (pf.ts pfWage).
 *
 * ONE rule (salary-revision.ts structureForGross) for the Basic that goes with a typed monthly gross —
 * Add employee, Edit employee and Revise salary all use it.
 */
import { describe, expect, it } from "vitest";
import { structureForGross, grossForAnnualCtc } from "./salary-revision";
import { basicFromPct } from "./net-pay";
import { ctcFromEmployee } from "./ctc";

describe("R-2773 structureForGross — the Basic for a typed gross", () => {
  it("NEW employee (no salary yet): Basic = company policy Basic % of the gross, not the whole gross", () => {
    expect(structureForGross(null, 30_000, 50)).toEqual({ monthly_gross: 30_000, basic_monthly: 15_000, da_monthly: 0 });
    expect(structureForGross(null, 30_000, 40)).toEqual({ monthly_gross: 30_000, basic_monthly: 12_000, da_monthly: 0 });
  });

  it("an employee saved with gross 0 is a new salary too → policy %", () => {
    expect(structureForGross({ monthly_gross: 0, basic_monthly: null, da_monthly: 0 }, 20_000, 50))
      .toEqual({ monthly_gross: 20_000, basic_monthly: 10_000, da_monthly: 0 });
  });

  it("rounds to whole rupees", () => {
    expect(structureForGross(null, 33_333, 50).basic_monthly).toBe(16_667);
  });

  it("never puts Basic above gross − DA", () => {
    expect(structureForGross({ monthly_gross: 0, basic_monthly: null, da_monthly: 20_000 }, 30_000, 50))
      .toEqual({ monthly_gross: 30_000, basic_monthly: 10_000, da_monthly: 20_000 });
  });

  it("policy 100% → Basic = gross (the company's own choice)", () => {
    expect(structureForGross(null, 30_000, 100).basic_monthly).toBe(30_000);
  });

  it("gross 0 / empty → no Basic", () => {
    expect(structureForGross(null, 0, 50)).toEqual({ monthly_gross: 0, basic_monthly: null, da_monthly: 0 });
  });

  it("an odd policy % falls back to the default 50%", () => {
    expect(structureForGross(null, 30_000, Number.NaN).basic_monthly).toBe(15_000);
    expect(structureForGross(null, 30_000, 0).basic_monthly).toBe(15_000);
  });

  it("EXISTING employee keeps their own Basic / DA share (as Revise salary always did)", () => {
    expect(structureForGross({ monthly_gross: 30_000, basic_monthly: 12_000, da_monthly: 3_000 }, 40_000, 50))
      .toEqual({ monthly_gross: 40_000, basic_monthly: 16_000, da_monthly: 4_000 });
  });

  it("EXISTING employee with Basic NOT set stays not set (R-2722 rule; repair is the owner's call)", () => {
    expect(structureForGross({ monthly_gross: 30_000, basic_monthly: null, da_monthly: 0 }, 36_000, 50))
      .toEqual({ monthly_gross: 36_000, basic_monthly: null, da_monthly: 0 });
  });

  it("basicFromPct (the Basic % dropdown) is the same rule", () => {
    expect(basicFromPct(0.5, 30_000, 0)).toBe(structureForGross(null, 30_000, 50).basic_monthly);
    expect(basicFromPct(0.5, 30_000, 20_000)).toBe(structureForGross({ monthly_gross: 0, basic_monthly: null, da_monthly: 20_000 }, 30_000, 50).basic_monthly);
  });

  it("PF on the policy Basic, not the whole gross: gross 30,000 → employee PF 1,800 (not 3,000)", () => {
    const s = structureForGross(null, 30_000, 50);
    const b = ctcFromEmployee({ ...s, pf_applicable: true, esi_applicable: false, pf_full_wage: false }, { asOf: "2026-11" });
    expect(b.basicMonthly).toBe(15_000);
    expect(b.employeePfMonthly).toBe(1_800);
    expect(b.basicAssumed).toBe(false);
  });

  it("Revise salary from a CTC on an employee with no salary yet uses the policy Basic too", () => {
    const current = { monthly_gross: 0, basic_monthly: null, da_monthly: 0, pf_applicable: true, esi_applicable: false };
    const g = grossForAnnualCtc(4_00_000, current, "2026-11", { gratuity: true, ctcIncludesEmployer: true, basicPct: 50 });
    const cost = ctcFromEmployee({ ...current, ...structureForGross(null, g, 50) }, { asOf: "2026-11" }).annualCtc;
    expect(cost).toBeLessThanOrEqual(4_00_000);
    // with Basic = whole gross the PF + gratuity would be larger and the gross smaller
    const wholeGross = grossForAnnualCtc(4_00_000, current, "2026-11", { gratuity: true, ctcIncludesEmployer: true, basicPct: 100 });
    expect(g).toBeGreaterThan(wholeGross);
  });
});
