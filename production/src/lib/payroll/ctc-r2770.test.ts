/**
 * R-2770 (Hitesh) — ONE monthly CTC per employee on every screen: the Employees table's
 * "CTC / month", the employee drawer, the Salary Register CTC tab and the Revise salary dialog
 * all go through employeeCtc() with the company payroll policy (gratuity on/off, CTC includes
 * the employer's PF / ESI / gratuity or not).
 */
import { describe, it, expect } from "vitest";
import { employeeCtc, employeeCtcOptions, ctcFromEmployee } from "./ctc";
import { grossForAnnualCtc } from "./salary-revision";
import { DEFAULT_PAYROLL_POLICY } from "./policy";

const NOV = "2026-11"; // PF ceiling ₹25,000 from Oct 2026 (pf.ts)
const emp = { monthly_gross: 30_000, basic_monthly: 15_000, da_monthly: 0, pf_applicable: true, esi_applicable: false, pf_full_wage: false };
const policy = (p: Partial<typeof DEFAULT_PAYROLL_POLICY>) => ({ ...DEFAULT_PAYROLL_POLICY, ...p });

describe("R-2770 employeeCtc — one CTC with the company policy", () => {
  it("default policy (CTC includes employer, gratuity on): 30,000 + PF 1,800 + gratuity 721", () => {
    expect(employeeCtc(emp, DEFAULT_PAYROLL_POLICY, NOV).monthlyCtc).toBe(32_521);
  });
  it("gratuity off: no gratuity in the CTC", () => {
    const c = employeeCtc(emp, policy({ gratuity: false }), NOV);
    expect(c.gratuityMonthly).toBe(0);
    expect(c.monthlyCtc).toBe(31_800);
  });
  it("CTC = gross policy: employer costs on top, CTC / month = gross", () => {
    expect(employeeCtc(emp, policy({ ctcIncludesEmployer: false }), NOV).monthlyCtc).toBe(30_000);
  });
  it("same number as ctcFromEmployee with the same options (drawer / register / table agree)", () => {
    const p = policy({ gratuity: false });
    expect(employeeCtc(emp, p, NOV)).toEqual(ctcFromEmployee(emp, { asOf: NOV, includeGratuity: false, ctcIncludesEmployer: true }));
    expect(employeeCtcOptions(p, NOV)).toEqual({ asOf: NOV, includeGratuity: false, ctcIncludesEmployer: true });
  });
  it("no salary set → CTC 0 (the table shows '—', never ₹0)", () => {
    expect(employeeCtc({ ...emp, monthly_gross: 0, basic_monthly: null }, DEFAULT_PAYROLL_POLICY, NOV).monthlyCtc).toBe(0);
  });
});

describe("R-2770 Revise salary — CTC → gross follows the same policy", () => {
  const switches = { ...emp };
  it("default policy: CTC 3,90,252 → gross 30,000 (round trip)", () => {
    expect(grossForAnnualCtc(32_521 * 12, switches, NOV)).toBe(30_000);
    expect(grossForAnnualCtc(32_521 * 12, switches, NOV, DEFAULT_PAYROLL_POLICY)).toBe(30_000);
  });
  it("gratuity off: CTC 3,81,600 → gross 30,000", () => {
    expect(grossForAnnualCtc(31_800 * 12, switches, NOV, policy({ gratuity: false }))).toBe(30_000);
  });
  it("CTC = gross policy: CTC 3,60,000 → gross 30,000", () => {
    expect(grossForAnnualCtc(360_000, switches, NOV, policy({ ctcIncludesEmployer: false }))).toBe(30_000);
  });
});
