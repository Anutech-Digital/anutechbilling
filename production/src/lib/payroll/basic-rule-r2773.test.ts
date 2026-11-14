/**
 * R-2773 review (rev-r2773 BLOCK, F1/F2/F4): the employee form's Basic rule as pure functions
 * (lib/payroll/basic-rule.ts) — what the Basic box fills, what Save stores, what the CTC tab /
 * Net Pay preview read, and when Save must wait for the company payroll policy.
 */
import { describe, expect, it } from "vitest";
import { employeeBasicFill, employeeBasicToSave, employeeSaveBlockedReason, type BasicRuleInput } from "./basic-rule";

const NEW: BasicRuleInput = {
  savedSalary: null, grossText: "30000", daText: "0", daFixed: true,
  basicText: "", policyBasicPct: 50, policyReady: true, pctPicked: null,
};
const OLD = { monthly_gross: 30_000, basic_monthly: 15_000, da_monthly: 0 };

describe("R-2773 employeeBasicFill — the Basic box for a typed gross", () => {
  it("new employee, policy loaded → policy Basic %", () => {
    expect(employeeBasicFill(NEW)).toEqual({ basic: "15000", da: "0" });
    expect(employeeBasicFill({ ...NEW, policyBasicPct: 40 })).toEqual({ basic: "12000", da: "0" });
  });

  it("F1: new employee, policy NOT loaded (loading / failed) → fills nothing (no silent 50%)", () => {
    expect(employeeBasicFill({ ...NEW, policyReady: false })).toBeNull();
  });

  it("F1: a Basic % picked in the dialog works without the policy", () => {
    expect(employeeBasicFill({ ...NEW, policyReady: false, pctPicked: 40 })).toEqual({ basic: "12000", da: "0" });
  });

  it("policy arrives later (40%) → the same call now fills 40%", () => {
    expect(employeeBasicFill({ ...NEW, policyReady: false, policyBasicPct: 40 })).toBeNull();
    expect(employeeBasicFill({ ...NEW, policyReady: true, policyBasicPct: 40 })?.basic).toBe("12000");
  });

  it("F4: gross cleared → Basic cleared too (no Basic left above an empty gross)", () => {
    expect(employeeBasicFill({ ...NEW, grossText: "" })).toEqual({ basic: "", da: "0" });
    expect(employeeBasicFill({ ...NEW, grossText: "0" })).toEqual({ basic: "", da: "0" });
  });

  it("DA re-caps Basic at gross − DA", () => {
    expect(employeeBasicFill({ ...NEW, daText: "20000" })).toEqual({ basic: "10000", da: "20000" });
  });

  it("existing employee: own share (Basic + DA), policy not needed", () => {
    expect(employeeBasicFill({ ...NEW, savedSalary: { ...OLD, da_monthly: 3_000 }, grossText: "40000", daFixed: false, policyReady: false }))
      .toEqual({ basic: "20000", da: "4000" });
    // DA typed in the dialog is kept; Basic capped under it
    expect(employeeBasicFill({ ...NEW, savedSalary: OLD, grossText: "40000", daText: "25000", daFixed: true }))
      .toEqual({ basic: "15000", da: "25000" });
  });

  it("existing employee with Basic not set: stays not set", () => {
    expect(employeeBasicFill({ ...NEW, savedSalary: { ...OLD, basic_monthly: null }, grossText: "36000", daFixed: false }))
      .toEqual({ basic: "", da: "0" });
  });
});

describe("R-2773 employeeBasicToSave — what Save stores (and the CTC tab / Net Pay preview read)", () => {
  it("a typed Basic is saved as typed", () => {
    expect(employeeBasicToSave({ ...NEW, basicText: "9000" })).toBe(9_000);
    expect(employeeBasicToSave({ ...NEW, basicText: "0" })).toBe(0);
  });

  it("empty Basic box, no-salary employee → the rule Basic, never null (null = 100% in payroll)", () => {
    expect(employeeBasicToSave(NEW)).toBe(15_000);
    expect(employeeBasicToSave({ ...NEW, policyBasicPct: 40 })).toBe(12_000);
  });

  it("empty Basic box, no gross → null (nothing to split)", () => {
    expect(employeeBasicToSave({ ...NEW, grossText: "" })).toBeNull();
  });

  it("empty Basic box, policy not loaded, no % picked → null (Save is blocked then — see below)", () => {
    expect(employeeBasicToSave({ ...NEW, policyReady: false })).toBeNull();
  });

  it("empty Basic box, existing employee → stays null (their saved 'not set')", () => {
    expect(employeeBasicToSave({ ...NEW, savedSalary: { ...OLD, basic_monthly: null } })).toBeNull();
  });
});

describe("R-2773 F1 employeeSaveBlockedReason — Save waits for the policy", () => {
  const base = { hasSalary: false, grossText: "30000", basicByHand: false, pctPicked: false, policyReady: false, policyFailed: false };

  it("new employee with a gross, policy loading → blocked with one plain sentence", () => {
    expect(employeeSaveBlockedReason(base)).toBe("Loading the company payroll policy (Basic %) — Save turns on in a moment.");
  });

  it("policy failed → says so and what to do", () => {
    expect(employeeSaveBlockedReason({ ...base, policyFailed: true }))
      .toBe("The company payroll policy (Basic %) could not load — reload the page, or type the Basic / pick a Basic % yourself.");
  });

  it("not blocked once the policy is in, or Basic typed by hand, or a % picked", () => {
    expect(employeeSaveBlockedReason({ ...base, policyReady: true })).toBeNull();
    expect(employeeSaveBlockedReason({ ...base, basicByHand: true })).toBeNull();
    expect(employeeSaveBlockedReason({ ...base, pctPicked: true })).toBeNull();
  });

  it("not blocked for an existing employee or with no gross (no Basic to work out)", () => {
    expect(employeeSaveBlockedReason({ ...base, hasSalary: true })).toBeNull();
    expect(employeeSaveBlockedReason({ ...base, grossText: "" })).toBeNull();
  });
});
