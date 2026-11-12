/**
 * R-2698 (Hitesh, 12 Nov 2026): Edit employee → untick "ESI applicable" / "PF applicable" →
 * the "CTC & Salary Breakdown" tab still showed Employee PF 12% and ESI deductions, because
 * calculateCtcBreakdown always charged PF (computePf(…, true)) and ESI (includeEsi default)
 * whatever the employee's switches said. The breakdown must follow the switches, and the
 * per-employee PF basis (capped / full Basic + DA).
 */
import { describe, it, expect } from "vitest";
import { calculateCtcBreakdown, ctcFromEmployee } from "./ctc";
import { pfWageCeiling } from "./pf";

describe("calculateCtcBreakdown follows the employee's PF / ESI switches", () => {
  it("PF off + ESI off → no PF or ESI on either side, the whole room is gross", () => {
    const b = calculateCtcBreakdown(360_000, { includePf: false, includeEsi: false, includeGratuity: false, asOf: "2026-11" });
    expect(b.employeePfMonthly).toBe(0);
    expect(b.employerPfMonthly).toBe(0);
    expect(b.employerEpsMonthly).toBe(0);
    expect(b.employerEpfShareMonthly).toBe(0);
    expect(b.employeeEsiMonthly).toBe(0);
    expect(b.employerEsiMonthly).toBe(0);
    expect(b.grossMonthly).toBe(30_000);
  });

  it("PF on (default) still charges PF — old callers unchanged", () => {
    const b = calculateCtcBreakdown(360_000, { asOf: "2026-11" });
    expect(b.employeePfMonthly).toBeGreaterThan(0);
  });

  it("ESI on but gross above ₹21,000 → ESI 0 (the ceiling rule)", () => {
    const b = calculateCtcBreakdown(600_000, { includePf: false, includeEsi: true, asOf: "2026-11" });
    expect(b.grossMonthly).toBeGreaterThan(21_000);
    expect(b.employeeEsiMonthly).toBe(0);
  });
});

describe("ctcFromEmployee — PF basis per employee", () => {
  const base = { monthly_gross: 60_000, basic_monthly: 40_000, da_monthly: 0, pf_applicable: true, esi_applicable: false };

  it("capped (default / pf_full_wage false) → 12% of the ceiling", () => {
    const c = ctcFromEmployee({ ...base, pf_full_wage: false }, { asOf: "2026-11" });
    expect(c.employeePfMonthly).toBe(Math.round(pfWageCeiling("2026-11") * 0.12));
  });

  it("full Basic + DA → 12% of 40,000; EPS stays capped", () => {
    const c = ctcFromEmployee({ ...base, pf_full_wage: true }, { asOf: "2026-11" });
    expect(c.employeePfMonthly).toBe(4_800);
    expect(c.employerPfMonthly).toBe(4_800);
    expect(c.employerEpsMonthly).toBe(Math.round(pfWageCeiling("2026-11") * 0.0833));
  });

  it("PF off → 0 even with full basis chosen", () => {
    const c = ctcFromEmployee({ ...base, pf_applicable: false, pf_full_wage: true }, { asOf: "2026-11" });
    expect(c.employeePfMonthly).toBe(0);
    expect(c.employerPfMonthly).toBe(0);
    expect(c.employerEpsMonthly).toBe(0);
  });
});
