/**
 * R-2699 — salary revision / increment with an effective-from month (Hitesh, 12 Nov 2026:
 * "us date se pehle ke payroll mein purani salary lage aur us date se nayi").
 *
 * The SQL side (employee_salary_arrears, revise_employee_salary) uses the same rule —
 * supabase/tests/r2699_salary_revision.test.sql proves it on the same numbers.
 */
import { describe, it, expect } from "vitest";
import {
  salaryInForce, arrearsForMonth, arrearsSummary, scaledStructure, grossForAnnualCtc,
  defaultEffectiveMonth, revisionMonth, arrearsPayableIn, revisionsByEmployee, type SalaryRevision,
} from "./salary-revision";
import { ctcFromEmployee } from "./ctc";
import { pfWage } from "./pf";

const rev = (p: Partial<SalaryRevision> & { effective_from: string; monthly_gross: number; prev_monthly_gross: number }): SalaryRevision => ({
  id: `r-${p.effective_from}`, employee_id: "e1", basic_monthly: null, da_monthly: 0,
  prev_basic_monthly: null, prev_da_monthly: 0, annual_ctc: null, note: null,
  created_by: null, created_at: "2026-11-12T10:00:00Z", ...p,
});

describe("salaryInForce — which salary a month is paid at", () => {
  // Owner's example: ₹30,000 → ₹36,000 from Dec 2026. The employee row holds the salary going forward.
  const employee = { monthly_gross: 36_000, basic_monthly: 18_000, da_monthly: 0 };
  const revisions = [rev({ effective_from: "2026-12-01", monthly_gross: 36_000, basic_monthly: 18_000, prev_monthly_gross: 30_000, prev_basic_monthly: 15_000 })];

  it("Nov 2026 (before the revision) keeps the old salary", () => {
    const s = salaryInForce(employee, revisions, "2026-11");
    expect(s.monthly_gross).toBe(30_000);
    expect(s.basic_monthly).toBe(15_000);
    expect(s.revision).toBeNull();
  });

  it("Dec 2026 (the revision's month) and later get the new salary", () => {
    expect(salaryInForce(employee, revisions, "2026-12").monthly_gross).toBe(36_000);
    expect(salaryInForce(employee, revisions, "2027-03").monthly_gross).toBe(36_000);
    expect(salaryInForce(employee, revisions, "2026-12").revision?.id).toBe("r-2026-12-01");
  });

  it("no revisions → the employee row", () => {
    expect(salaryInForce(employee, [], "2026-01").monthly_gross).toBe(36_000);
  });

  it("two revisions (Oct 33k, Dec 36k): Sep 30k, Nov 33k, Jan 36k — order of the list does not matter", () => {
    const two = [
      rev({ effective_from: "2026-12-01", monthly_gross: 36_000, prev_monthly_gross: 33_000 }),
      rev({ effective_from: "2026-10-01", monthly_gross: 33_000, prev_monthly_gross: 30_000 }),
    ];
    expect(salaryInForce(employee, two, "2026-09").monthly_gross).toBe(30_000);
    expect(salaryInForce(employee, two, "2026-10").monthly_gross).toBe(33_000);
    expect(salaryInForce(employee, two, "2026-11").monthly_gross).toBe(33_000);
    expect(salaryInForce(employee, two, "2027-01").monthly_gross).toBe(36_000);
  });

  it("R-2698 FU1: paying Nov after the raise prorates PF on Nov's own gross, not the new one", () => {
    const nov = salaryInForce(employee, revisions, "2026-11");
    // Full Nov salary 30,000: PF wage = full Basic 15,000 (not 30,000 / 36,000 of it).
    expect(pfWage({ gross: 30_000, basic: nov.basic_monthly, da: nov.da_monthly, monthlyGross: nov.monthly_gross }).base).toBe(15_000);
    // The old bug: proration by the CURRENT employee gross.
    expect(pfWage({ gross: 30_000, basic: nov.basic_monthly, da: nov.da_monthly, monthlyGross: employee.monthly_gross }).base).toBe(12_500);
  });
});

describe("arrearsForMonth — a month booked at the old salary", () => {
  it("full month 30,000 → 36,000 = 6,000", () => {
    expect(arrearsForMonth(30_000, 30_000, 36_000)).toBe(6_000);
  });
  it("part month / LOP: earned 15,000 at old 30k → 3,000", () => {
    expect(arrearsForMonth(15_000, 30_000, 36_000)).toBe(3_000);
  });
  it("rounds to the rupee", () => {
    expect(arrearsForMonth(10_001, 30_000, 33_333)).toBe(Math.round(10_001 * 33_333 / 30_000) - 10_001);
  });
  it("no rise, a cut, zero old gross or zero earned → 0", () => {
    expect(arrearsForMonth(30_000, 30_000, 30_000)).toBe(0);
    expect(arrearsForMonth(30_000, 30_000, 25_000)).toBe(0);
    expect(arrearsForMonth(30_000, 0, 36_000)).toBe(0);
    expect(arrearsForMonth(0, 30_000, 36_000)).toBe(0);
  });
});

describe("arrearsSummary — what the next Pay salary offers", () => {
  it("due 12,000, nothing paid → offer 12,000", () => {
    const s = arrearsSummary([{ period: "2026-10", arrears: 6_000 }, { period: "2026-11", arrears: 6_000 }], 0);
    expect(s).toMatchObject({ due: 12_000, paid: 0, outstanding: 12_000, overpaid: 0 });
    expect(s.monthsLabel).toBe("Oct 2026, Nov 2026");
  });
  it("arrears ride only on a month AFTER the arrears months (never a backlog month before the raise)", () => {
    const s = arrearsSummary([{ period: "2026-10", arrears: 6_000 }, { period: "2026-11", arrears: 6_000 }], 0);
    expect(s.lastMonth).toBe("2026-11");
    expect(arrearsPayableIn(s, "2026-12")).toBe(true);
    expect(arrearsPayableIn(s, "2026-11")).toBe(false);
    expect(arrearsPayableIn(s, "2026-09")).toBe(false);
    expect(arrearsPayableIn(arrearsSummary([], 0), "2026-12")).toBe(false);
  });
  it("paid once → nothing left", () => {
    expect(arrearsSummary([{ period: "2026-10", arrears: 6_000 }], 6_000).outstanding).toBe(0);
  });
  it("a month redone at the new salary after its arrears were paid → overpaid shown, never negative", () => {
    const s = arrearsSummary([], 6_000);
    expect(s.outstanding).toBe(0);
    expect(s.overpaid).toBe(6_000);
  });
});

describe("Revise salary dialog helpers", () => {
  it("scaledStructure keeps the Basic / DA share of gross", () => {
    expect(scaledStructure({ monthly_gross: 30_000, basic_monthly: 15_000, da_monthly: 3_000 }, 36_000))
      .toEqual({ monthly_gross: 36_000, basic_monthly: 18_000, da_monthly: 3_600 });
    expect(scaledStructure({ monthly_gross: 30_000, basic_monthly: null, da_monthly: 0 }, 36_000))
      .toEqual({ monthly_gross: 36_000, basic_monthly: null, da_monthly: 0 });
  });

  it("grossForAnnualCtc: the gross whose CTC (ctcFromEmployee) is the typed CTC, same switches", () => {
    const base = { monthly_gross: 30_000, basic_monthly: 15_000, da_monthly: 0, pf_applicable: true, esi_applicable: false, pf_full_wage: false };
    const target = ctcFromEmployee({ ...base, ...scaledStructure(base, 36_000) }, { asOf: "2026-12" }).annualCtc;
    expect(grossForAnnualCtc(target, base, "2026-12")).toBe(36_000);
    // A CTC between two whole-rupee grosses → the largest gross that fits.
    const g = grossForAnnualCtc(target + 5, base, "2026-12");
    expect(ctcFromEmployee({ ...base, ...scaledStructure(base, g) }, { asOf: "2026-12" }).annualCtc).toBeLessThanOrEqual(target + 5);
    expect(grossForAnnualCtc(0, base, "2026-12")).toBe(0);
  });

  it("grossForAnnualCtc with ESI on: the CTC of a gross just above ₹21,000 → that gross (CTC dips above the ESI ceiling)", () => {
    const esiOn = { monthly_gross: 20_000, basic_monthly: null, da_monthly: 0, pf_applicable: false, esi_applicable: true, pf_full_wage: false };
    const target = ctcFromEmployee({ ...esiOn, monthly_gross: 21_600 }, { asOf: "2026-12" }).annualCtc;
    expect(grossForAnnualCtc(target, esiOn, "2026-12")).toBe(21_600);
    const below = ctcFromEmployee({ ...esiOn, monthly_gross: 20_500 }, { asOf: "2026-12" }).annualCtc;
    // The same CTC also fits a gross just above the ceiling (no employer ESI there) — the larger one wins.
    const g = grossForAnnualCtc(below, esiOn, "2026-12");
    expect(g).toBeGreaterThan(21_000);
    expect(ctcFromEmployee({ ...esiOn, monthly_gross: g }, { asOf: "2026-12" }).annualCtc).toBeLessThanOrEqual(below);
  });

  it("defaultEffectiveMonth = the month after the last paid one, never before this month", () => {
    expect(defaultEffectiveMonth("2026-11-12", null)).toBe("2026-11");
    expect(defaultEffectiveMonth("2026-11-12", "2026-12")).toBe("2027-01");
    expect(defaultEffectiveMonth("2026-12-31", "2026-10")).toBe("2026-12");
  });

  it("revisionsByEmployee groups and sorts once", () => {
    const m = revisionsByEmployee([
      rev({ effective_from: "2026-12-01", monthly_gross: 36_000, prev_monthly_gross: 33_000 }),
      { ...rev({ effective_from: "2026-05-01", monthly_gross: 20_000, prev_monthly_gross: 18_000 }), employee_id: "e2" },
      rev({ effective_from: "2026-10-01", monthly_gross: 33_000, prev_monthly_gross: 30_000 }),
    ]);
    expect(m.get("e1")?.map((r) => r.effective_from)).toEqual(["2026-10-01", "2026-12-01"]);
    expect(m.get("e2")?.length).toBe(1);
  });

  it("revisionMonth reads the date as a month", () => {
    expect(revisionMonth({ effective_from: "2026-12-01" })).toBe("2026-12");
  });
});
