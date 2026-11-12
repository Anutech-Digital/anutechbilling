/**
 * R-2700 — company payroll policy: parse (no row = old behaviour), validate the owner's input,
 * new-employee defaults, summary text; and the policy never reaches salary booking.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_PAYROLL_POLICY, parsePayrollPolicy, policyToRow, validatePayrollPolicyInput,
  newEmployeeDefaults, payrollPolicySummary, BASIC_PCT_ERROR, basicPctWarning, policyChangeText,
} from "./policy";

describe("R-2700 parsePayrollPolicy", () => {
  it("no settings row → the pre-R-2700 behaviour", () => {
    expect(parsePayrollPolicy(null)).toEqual({
      pfDefault: false, pfFullWageDefault: false, esiDefault: true, gratuity: true, ctcIncludesEmployer: true, basicPct: 50,
    });
    expect(parsePayrollPolicy(undefined)).toEqual(DEFAULT_PAYROLL_POLICY);
  });
  it("reads a saved row, field by field; odd values fall back", () => {
    expect(parsePayrollPolicy({
      payroll_pf_default: true, payroll_pf_full_wage_default: true, payroll_esi_default: false,
      payroll_gratuity: false, payroll_ctc_includes_employer: false, payroll_basic_pct: 40,
    })).toEqual({ pfDefault: true, pfFullWageDefault: true, esiDefault: false, gratuity: false, ctcIncludesEmployer: false, basicPct: 40 });
    expect(parsePayrollPolicy({ payroll_pf_default: null, payroll_basic_pct: 150 })).toEqual(DEFAULT_PAYROLL_POLICY);
  });
  it("round-trips through the DB columns", () => {
    const p = { pfDefault: true, pfFullWageDefault: false, esiDefault: false, gratuity: true, ctcIncludesEmployer: false, basicPct: 60 };
    expect(parsePayrollPolicy(policyToRow(p))).toEqual(p);
    expect(Object.keys(policyToRow(p)).every((k) => k.startsWith("payroll_"))).toBe(true);
  });
});

describe("R-2700 validatePayrollPolicyInput", () => {
  const good = { pfDefault: true, pfFullWageDefault: false, esiDefault: true, gratuity: true, ctcIncludesEmployer: true, basicPct: 40 };
  it("accepts a complete policy (Basic % as text too)", () => {
    expect(validatePayrollPolicyInput(good)).toEqual({ ok: true, policy: good });
    expect(validatePayrollPolicyInput({ ...good, basicPct: "45" })).toEqual({ ok: true, policy: { ...good, basicPct: 45 } });
  });
  it.each([0, 9, 101, 150, 45.5, "abc", "", null])("refuses Basic %% %s", (basicPct) => {
    expect(validatePayrollPolicyInput({ ...good, basicPct })).toEqual({ ok: false, error: BASIC_PCT_ERROR });
  });
  it("refuses a missing / non-boolean switch", () => {
    expect(validatePayrollPolicyInput({ ...good, gratuity: "yes" }).ok).toBe(false);
    expect(validatePayrollPolicyInput(null).ok).toBe(false);
  });
});

describe("R-2700 newEmployeeDefaults", () => {
  it("PF / basis / gratuity / Basic % from the policy; ESI only when registered AND gross ≤ ₹21,000", () => {
    const p = { ...DEFAULT_PAYROLL_POLICY, pfDefault: true, pfFullWageDefault: true, basicPct: 40, gratuity: false };
    expect(newEmployeeDefaults(p, true)).toEqual({ pfApplicable: true, pfFullWage: true, esiApplicable: true, includeGratuity: false, basicPct: 0.4 });
    expect(newEmployeeDefaults(p, false).esiApplicable).toBe(false);
    expect(newEmployeeDefaults({ ...p, esiDefault: false }, true).esiApplicable).toBe(false);
    // full-wage basis means nothing while PF is off
    expect(newEmployeeDefaults({ ...p, pfDefault: false }, true).pfFullWage).toBe(false);
  });
});

describe("R-2700 payrollPolicySummary", () => {
  it("names the ceilings and the CTC rule", () => {
    const lines = payrollPolicySummary({ ...DEFAULT_PAYROLL_POLICY, pfDefault: true }, 25_000, 21_000);
    expect(lines[0]).toBe("PF: on for new employees — 12% of Basic + DA up to ₹25,000");
    expect(lines[1]).toBe("ESI: on when monthly gross is ₹21,000 or less");
    expect(lines[3]).toMatch(/CTC includes employer PF \/ ESI \/ gratuity/);
    expect(payrollPolicySummary({ ...DEFAULT_PAYROLL_POLICY, ctcIncludesEmployer: false }, 25_000, 21_000)[3]).toMatch(/on top/);
  });
});

describe("R-2700 the policy never changes a salary that is booked", () => {
  it("Pay salary / salary-from-bank do not read the policy (they read the employee's own switches)", () => {
    const root = join(__dirname, "..", "..");
    for (const f of ["lib/queries/salary-from-bank.ts", "lib/queries/payroll.ts", "lib/payroll/pf.ts", "lib/payroll/esi.ts"]) {
      const src = readFileSync(join(root, f), "utf8");
      expect(src, f).not.toMatch(/payroll\/policy|PayrollPolicy|payroll-policy/);
    }
  });
});

describe("R-2700 review fixes (F3, M2 warning, F5 log line)", () => {
  it("F3: Basic % is of CTC ÷ 12 under includes, of the gross under excludes", () => {
    expect(payrollPolicySummary(DEFAULT_PAYROLL_POLICY, 25_000, 21_000)[4]).toBe("Basic: 50% of CTC ÷ 12");
    expect(payrollPolicySummary({ ...DEFAULT_PAYROLL_POLICY, ctcIncludesEmployer: false }, 25_000, 21_000)[4]).toBe("Basic: 50% of the monthly gross");
  });
  it("M2: the card warns for a Basic % that will not fit", () => {
    expect(basicPctWarning({ basicPct: 50, ctcIncludesEmployer: true })).toBeNull();
    expect(basicPctWarning({ basicPct: 70, ctcIncludesEmployer: true })).toMatch(/HRA and allowances are lowered/);
    expect(basicPctWarning({ basicPct: 90, ctcIncludesEmployer: true })).toMatch(/does not fit lower salaries/);
    expect(basicPctWarning({ basicPct: 100, ctcIncludesEmployer: false })).toMatch(/HRA and allowances are lowered/);
  });
  it("F5: activity line names each change old → new", () => {
    expect(policyChangeText(DEFAULT_PAYROLL_POLICY, { ...DEFAULT_PAYROLL_POLICY, pfDefault: true, basicPct: 40, ctcIncludesEmployer: false }))
      .toBe("Payroll policy changed: PF for new employees off → on; CTC includes → excludes employer PF / ESI / gratuity; Basic 50% → 40%");
    expect(policyChangeText(DEFAULT_PAYROLL_POLICY, DEFAULT_PAYROLL_POLICY)).toBe("Payroll policy saved (no change)");
  });
});
