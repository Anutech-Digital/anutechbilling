/**
 * R-1585 — the CTC numbers must come from the shared statutory modules (pf.ts, esi.ts, pt.ts)
 * and from the employee's real salary structure, never from "monthly gross × 12".
 *
 * Bugs these tests pin (before the fix):
 *  • salary-register/page.tsx:148 and :280, employee-detail-drawer.tsx:110 —
 *    calculateCtcBreakdown(e.monthly_gross * 12) treats the GROSS as the CTC, so a ₹30,000-gross
 *    employee showed a register "Gross" below ₹30,000 and a CTC of exactly ₹3,60,000.
 *  • ctc.ts:128-130 — ESI eligibility tested on Basic+HRA+Conveyance+Medical (special allowance
 *    left out), so ESI was charged on a final gross above ₹21,000.
 *  • ctc.ts:130 and :146 — ESI rates hard-coded with Math.round; ESIC rounds UP (esi.ts).
 *  • ctc.ts:147-149 — PT slab hard-coded inside the calculator.
 */
import { describe, it, expect } from "vitest";
import { calculateCtcBreakdown, ctcFromEmployee } from "./ctc";
import { computeEsi, ESI_WAGE_CEILING } from "./esi";
import { computePf } from "./pf";
import { computePt } from "./pt";

const emp = (over: Partial<Parameters<typeof ctcFromEmployee>[0]> = {}) => ({
  monthly_gross: 30_000, basic_monthly: 15_000, da_monthly: 0, pf_applicable: true, esi_applicable: true, ...over,
});

describe("ctcFromEmployee — the register reads the employee's own structure", () => {
  it("₹30,000 gross: gross stays ₹30,000; PF/ESI/PT come from the shared modules; CTC = gross + employer cost", () => {
    const c = ctcFromEmployee(emp(), { asOf: "2026-10" });
    const pf = computePf(15_000, true, "2026-10");
    const esi = computeEsi(30_000, true);
    expect(c.grossMonthly).toBe(30_000);
    expect(c.grossAnnual).toBe(360_000);
    expect(c.employerPfMonthly).toBe(pf.employer);
    expect(c.employeePfMonthly).toBe(pf.employee);
    expect(c.employerEsiMonthly).toBe(esi.employer); // 0 — above the ₹21,000 ceiling
    expect(c.employeeEsiMonthly).toBe(0);
    expect(c.professionalTaxMonthly).toBe(computePt(30_000).monthly);
    expect(c.gratuityMonthly).toBe(Math.round(15_000 * 15 / 26 / 12));
    expect(c.monthlyCtc).toBe(30_000 + pf.employer + c.gratuityMonthly);
    expect(c.annualCtc).toBe(c.monthlyCtc * 12);
    expect(c.annualCtc).toBeGreaterThan(360_000); // CTC is never below the gross
    expect(c.netTakeHomeMonthly).toBe(30_000 - pf.employee - c.professionalTaxMonthly);
  });

  it("ESI threshold: ₹21,000 gross is covered (rounded up), ₹21,001 is not, and an exempt employee pays none", () => {
    const at = ctcFromEmployee(emp({ monthly_gross: ESI_WAGE_CEILING, basic_monthly: 10_500 }), { asOf: "2026-10" });
    expect(at.employerEsiMonthly).toBe(Math.ceil(21_000 * 0.0325));
    expect(at.employeeEsiMonthly).toBe(Math.ceil(21_000 * 0.0075));
    const over = ctcFromEmployee(emp({ monthly_gross: 21_001, basic_monthly: 10_500 }), { asOf: "2026-10" });
    expect(over.employerEsiMonthly).toBe(0);
    expect(over.employeeEsiMonthly).toBe(0);
    const exempt = ctcFromEmployee(emp({ monthly_gross: 15_000, esi_applicable: false }), { asOf: "2026-10" });
    expect(exempt.employerEsiMonthly).toBe(0);
  });

  it("no Basic on the employee → PF on the whole gross (same as payroll's pfWage) and it says so", () => {
    const c = ctcFromEmployee(emp({ monthly_gross: 12_000, basic_monthly: null }), { asOf: "2026-09" });
    expect(c.basicAssumed).toBe(true);
    expect(c.employerPfMonthly).toBe(computePf(12_000, true, "2026-09").employer);
  });

  it("PF ceiling is the salary month's (₹15,000 till Sep 2026, ₹25,000 from Oct 2026)", () => {
    const hi = emp({ monthly_gross: 60_000, basic_monthly: 30_000 });
    expect(ctcFromEmployee(hi, { asOf: "2026-09" }).employerPfMonthly).toBe(1_800);
    expect(ctcFromEmployee(hi, { asOf: "2026-10" }).employerPfMonthly).toBe(3_000);
  });

  it("PT follows the shared PT module, and a custom PT on the employee wins", () => {
    expect(ctcFromEmployee(emp({ monthly_gross: 12_000, basic_monthly: 6_000 })).professionalTaxMonthly).toBe(computePt(12_000).monthly);
    expect(ctcFromEmployee(emp(), { ptMonthly: 0 }).professionalTaxMonthly).toBe(0);
  });
});

describe("calculateCtcBreakdown — ESI/PT via the shared modules", () => {
  it("no ESI when the FINAL gross (with special allowance) is above ₹21,000 — ctc.ts:128 tested a partial gross", () => {
    const c = calculateCtcBreakdown(25_500 * 12, { asOf: "2026-09" });
    expect(c.grossMonthly).toBeGreaterThan(ESI_WAGE_CEILING);
    expect(c.employerEsiMonthly).toBe(0);
    expect(c.employeeEsiMonthly).toBe(0);
  });

  it("ESI on the final gross, rounded UP like ESIC (esi.ts) — not Math.round on a partial gross", () => {
    const c = calculateCtcBreakdown(0, {
      customBasicMonthly: 7_550, customHraMonthly: 3_020, customConveyanceMonthly: 0, customMedicalMonthly: 0, customSpecialMonthly: 4_530,
    });
    expect(c.grossMonthly).toBe(15_100);
    expect(c.employerEsiMonthly).toBe(computeEsi(15_100).employer);
    expect(c.employeeEsiMonthly).toBe(computeEsi(15_100).employee);
  });

  it("with ESI applicable the CTC still adds up: gross + employer PF + employer ESI + gratuity = monthly CTC", () => {
    const c = calculateCtcBreakdown(18_000 * 12, { asOf: "2026-09", customConveyanceMonthly: 0, customMedicalMonthly: 0 });
    expect(c.grossMonthly).toBeLessThanOrEqual(ESI_WAGE_CEILING);
    expect(c.employerEsiMonthly).toBe(computeEsi(c.grossMonthly).employer);
    expect(c.grossMonthly + c.employerPfMonthly + c.employerEsiMonthly + c.gratuityMonthly).toBeLessThanOrEqual(c.monthlyCtc);
    expect(c.monthlyCtc - (c.grossMonthly + c.totalEmployerContributionMonthly)).toBeLessThanOrEqual(1);
  });

  it("PT default comes from pt.ts, a typed PT overrides it", () => {
    const c = calculateCtcBreakdown(30_000 * 12);
    expect(c.professionalTaxMonthly).toBe(computePt(c.grossMonthly).monthly);
    expect(calculateCtcBreakdown(30_000 * 12, { customPtMonthly: 0 }).professionalTaxMonthly).toBe(0);
  });
});
