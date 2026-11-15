/**
 * R-2773 (Hitesh 14 Nov, feedback 043e6753) — the Add / Edit employee form's Basic rule as pure
 * functions, so what the Basic box fills, what Save stores and what the CTC tab / Net Pay preview
 * show are ONE rule (salary-revision.ts structureForGross):
 *   • an employee with no salary yet → the company payroll policy's Basic % of the gross
 *     (or the Basic % picked in the dialog), never above gross − DA;
 *   • an existing employee → their own Basic / DA share; "not set" stays not set.
 * Review F1: the policy % is used only once the policy has really loaded (policyReady) — never a
 * silent default 50% while it is loading or failed; Save waits for it (employeeSaveBlockedReason)
 * unless the Basic was typed by hand or a Basic % was picked.
 */
import { structureForGross, type SalaryStructure } from "./salary-revision";

export interface BasicRuleInput {
  /** The employee's saved salary when they have one (gross > 0); null = no salary yet. */
  savedSalary: SalaryStructure | null;
  /** The form's Monthly Gross / DA / Basic boxes as typed. */
  grossText: string;
  daText: string;
  /** true = keep the form's DA (typed in this dialog, or a new employee); false = DA follows the saved share. */
  daFixed: boolean;
  basicText: string;
  /** The company payroll policy's Basic % (whole number) and whether that policy has loaded. */
  policyBasicPct: number;
  policyReady: boolean;
  /** A Basic % (whole number) picked in this dialog — used instead of the policy; null = none. */
  pctPicked: number | null;
}

const whole = (t: string) => Math.max(0, Math.round(Number(t) || 0));

/**
 * What the Basic (and DA) boxes hold for this gross. `basic: ""` = empty (no gross, or an existing
 * employee whose Basic is not set). null = do not touch the boxes (no salary yet and no policy
 * loaded / no % picked — the form says Save is waiting).
 */
export function employeeBasicFill(i: BasicRuleInput): { basic: string; da: string } | null {
  const g = whole(i.grossText);
  const formDa = whole(i.daText);
  if (g <= 0) return { basic: "", da: String(formDa) };
  const saved = i.savedSalary && i.savedSalary.monthly_gross > 0 ? i.savedSalary : null;
  // An existing employee keeps their own share (the % is not used); no salary yet → picked % or the loaded policy.
  const pct = saved ? i.policyBasicPct : i.pctPicked ?? (i.policyReady ? i.policyBasicPct : null);
  if (pct === null) return null;
  const s = structureForGross(saved ?? { monthly_gross: 0, basic_monthly: null, da_monthly: formDa }, g, pct);
  const da = saved && !i.daFixed ? Math.max(0, s.da_monthly ?? 0) : formDa;
  const b = s.basic_monthly === null ? null : Math.min(s.basic_monthly, Math.max(0, g - da));
  return { basic: b === null ? "" : String(b), da: String(da) };
}

/**
 * The Basic Save stores — and the one the CTC tab / Net Pay preview read, so they match (review F4).
 * A typed Basic as typed; an empty box on a no-salary employee = the rule's Basic (never null, which
 * payroll reads as Basic = the whole gross); an empty box on an existing employee = null (their
 * saved "not set"). null also when the rule cannot be worked out (no gross / no policy yet).
 */
export function employeeBasicToSave(i: BasicRuleInput): number | null {
  if (i.basicText.trim() !== "") return whole(i.basicText);
  if (i.savedSalary && i.savedSalary.monthly_gross > 0) return null;
  const f = employeeBasicFill({ ...i, daFixed: true });
  return f && f.basic !== "" ? Number(f.basic) : null;
}

/** Review F1: why Save is off for an employee with no salary yet while the policy is not in; null = may save. */
export function employeeSaveBlockedReason(i: {
  hasSalary: boolean; grossText: string; basicByHand: boolean; pctPicked: boolean; policyReady: boolean; policyFailed: boolean;
}): string | null {
  if (i.hasSalary || whole(i.grossText) <= 0 || i.basicByHand || i.pctPicked || i.policyReady) return null;
  return i.policyFailed
    ? "The company payroll policy (Basic %) could not load — reload the page, or type the Basic / pick a Basic % yourself."
    : "Loading the company payroll policy (Basic %) — Save turns on in a moment.";
}
