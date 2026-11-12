/**
 * Company payroll policy (R-2700, Hitesh 12 Nov 2026 item 8) — the company's own PF / ESI /
 * gratuity rules and how a CTC is split, set ONCE and used as:
 *   • the defaults for a NEW employee (PF on/off, PF basis, ESI suggestion, Basic %), and
 *   • the rule the CTC calculator uses to turn an Annual CTC into the Monthly Gross.
 * Existing employees keep their own saved switches; Pay salary never reads this policy
 * (it reads the employee's switches), so booked months never change because of it.
 *
 * Stored on the workspace's HR settings row (attendance_settings, payroll_* columns) — the
 * same row that holds the late / half-day salary rules (R-439/R-604). No row = DEFAULT_POLICY,
 * which is exactly how the app behaved before this card.
 *
 * The statutory numbers themselves are NOT here: PF rate + wage ceiling (₹25,000 from Oct 2026,
 * Pardeep's decision) live in pf.ts, ESI rates + ₹21,000 ceiling in esi.ts, gratuity 15/26 of
 * Basic a year in ctc.ts.
 */
import { rupee } from "@/lib/utils";

export interface PayrollPolicy {
  /** A new employee starts with PF applicable. */
  pfDefault: boolean;
  /** A new PF employee's PF is on the full Basic + DA (true) or capped at the month's ceiling. */
  pfFullWageDefault: boolean;
  /** The company is ESI-registered: a new employee is ESI-covered when gross ≤ ₹21,000. */
  esiDefault: boolean;
  /** Gratuity provision (15 days' Basic a year ≈ 4.81%) is part of the CTC. */
  gratuity: boolean;
  /** CTC includes the employer's PF / ESI / gratuity (gross = CTC/12 − those) — else they are on top. */
  ctcIncludesEmployer: boolean;
  /** Basic as % of the monthly salary the CTC gives (10–100). */
  basicPct: number;
}

/** Today's behaviour before R-2700 — a workspace that never saved a policy sees no change. */
export const DEFAULT_PAYROLL_POLICY: PayrollPolicy = Object.freeze({
  pfDefault: false,
  pfFullWageDefault: false,
  esiDefault: true,
  gratuity: true,
  ctcIncludesEmployer: true,
  basicPct: 50,
});

/** The DB row's columns (attendance_settings). */
export interface PayrollPolicyRow {
  payroll_pf_default?: boolean | null;
  payroll_pf_full_wage_default?: boolean | null;
  payroll_esi_default?: boolean | null;
  payroll_gratuity?: boolean | null;
  payroll_ctc_includes_employer?: boolean | null;
  payroll_basic_pct?: number | null;
}

export const PAYROLL_POLICY_COLUMNS =
  "payroll_pf_default, payroll_pf_full_wage_default, payroll_esi_default, payroll_gratuity, payroll_ctc_includes_employer, payroll_basic_pct";

export const BASIC_PCT_MIN = 10;
export const BASIC_PCT_MAX = 100;

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** Row (or nothing) → policy, field by field — a missing / odd value falls back to the default. */
export function parsePayrollPolicy(row: PayrollPolicyRow | null | undefined): PayrollPolicy {
  const d = DEFAULT_PAYROLL_POLICY;
  const pct = Number(row?.payroll_basic_pct);
  return {
    pfDefault: bool(row?.payroll_pf_default, d.pfDefault),
    pfFullWageDefault: bool(row?.payroll_pf_full_wage_default, d.pfFullWageDefault),
    esiDefault: bool(row?.payroll_esi_default, d.esiDefault),
    gratuity: bool(row?.payroll_gratuity, d.gratuity),
    ctcIncludesEmployer: bool(row?.payroll_ctc_includes_employer, d.ctcIncludesEmployer),
    basicPct: Number.isInteger(pct) && pct >= BASIC_PCT_MIN && pct <= BASIC_PCT_MAX ? pct : d.basicPct,
  };
}

/** Policy → the DB columns to write (only these — the row's attendance columns are never sent). */
export function policyToRow(p: PayrollPolicy): { [K in keyof PayrollPolicyRow]-?: NonNullable<PayrollPolicyRow[K]> } {
  return {
    payroll_pf_default: p.pfDefault,
    payroll_pf_full_wage_default: p.pfFullWageDefault,
    payroll_esi_default: p.esiDefault,
    payroll_gratuity: p.gratuity,
    payroll_ctc_includes_employer: p.ctcIncludesEmployer,
    payroll_basic_pct: p.basicPct,
  };
}

export const BASIC_PCT_ERROR = `Basic must be between ${BASIC_PCT_MIN}% and ${BASIC_PCT_MAX}% of the salary.`;

/** Owner's form input → a policy, or one sentence saying what is wrong. Every field is required. */
export function validatePayrollPolicyInput(input: unknown): { ok: true; policy: PayrollPolicy } | { ok: false; error: string } {
  const v = (input ?? {}) as Record<string, unknown>;
  const flags = ["pfDefault", "pfFullWageDefault", "esiDefault", "gratuity", "ctcIncludesEmployer"] as const;
  for (const f of flags) {
    if (typeof v[f] !== "boolean") return { ok: false, error: "Payroll policy is incomplete — reload the page and save again." };
  }
  const pct = typeof v.basicPct === "number" ? v.basicPct : typeof v.basicPct === "string" && v.basicPct.trim() !== "" ? Number(v.basicPct) : NaN;
  if (!Number.isInteger(pct) || pct < BASIC_PCT_MIN || pct > BASIC_PCT_MAX) return { ok: false, error: BASIC_PCT_ERROR };
  return {
    ok: true,
    policy: {
      pfDefault: v.pfDefault as boolean,
      pfFullWageDefault: v.pfFullWageDefault as boolean,
      esiDefault: v.esiDefault as boolean,
      gratuity: v.gratuity as boolean,
      ctcIncludesEmployer: v.ctcIncludesEmployer as boolean,
      basicPct: pct,
    },
  };
}

/** One line per rule, for the policy card's summary. `pfCeiling` = pf.ts pfWageCeiling() today. */
export function payrollPolicySummary(p: PayrollPolicy, pfCeiling: number, esiCeiling: number): string[] {
  return [
    p.pfDefault
      ? `PF: on for new employees — ${p.pfFullWageDefault ? "12% of the full Basic + DA" : `12% of Basic + DA up to ${rupee(pfCeiling)}`}`
      : "PF: off for new employees",
    p.esiDefault ? `ESI: on when monthly gross is ${rupee(esiCeiling)} or less` : "ESI: off for new employees",
    p.gratuity ? "Gratuity: 4.81% of Basic accrued in CTC" : "Gratuity: not accrued",
    p.ctcIncludesEmployer
      ? "CTC includes employer PF / ESI / gratuity — monthly gross = CTC ÷ 12 minus them"
      : "CTC = gross pay — employer PF / ESI / gratuity are paid on top",
    `Basic: ${p.basicPct}% of the monthly salary`,
  ];
}

/** Defaults a NEW employee's form starts with. `esiApplicable` follows the ₹21,000 rule only
 *  when the company is ESI-registered. */
export function newEmployeeDefaults(p: PayrollPolicy, esiEligibleForGross: boolean): {
  pfApplicable: boolean; pfFullWage: boolean; esiApplicable: boolean; includeGratuity: boolean; basicPct: number;
} {
  return {
    pfApplicable: p.pfDefault,
    pfFullWage: p.pfDefault && p.pfFullWageDefault,
    esiApplicable: p.esiDefault && esiEligibleForGross,
    includeGratuity: p.gratuity,
    basicPct: p.basicPct / 100,
  };
}
