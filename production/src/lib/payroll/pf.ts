import { istToday } from "@/lib/dates/ist";
/**
 * PF (Employees' Provident Fund / EPF) — statutory retirement contribution.
 *
 * SINGLE SOURCE OF TRUTH for PF rates + ceiling. Mirrors esi.ts. If EPFO revises
 * rates or the wage ceiling, change them HERE only.
 *
 * Rules:
 *   • PF wages are capped at the statutory ceiling for the month being paid:
 *     ₹15,000 up to Sep 2026, ₹25,000 from the October 2026 salary onwards
 *     (Pardeep, 27 Sep 2026). Contribution is computed on min(wage, ceiling).
 *   • Employee contributes 12% of PF wages; employer contributes 12%
 *     (internally 8.33% EPS + 3.67% EPF — but the total employer cost is 12%).
 *   • Employer also pays small admin/EDLI charges (~1%) which are NOT modelled in
 *     v1 — the employer figure here is the 12% contribution only. Adjust the
 *     "employer PF" field manually if you want to include admin/EDLI.
 *   • Applies to employees the owner marks PF-applicable (has an EPFO account).
 *
 * ─── WHY THE CEILING IS A DATED TABLE ────────────────────────────────────────
 * A single constant would re-compute every OLD payslip at the new ceiling the day
 * it changed — August's PF would print differently in November than it did in
 * September, and the ECR already filed for August would no longer match the app.
 * The ceiling is looked up by the salary PERIOD, so a month keeps the ceiling that
 * was law when it was paid, and the next revision is one more row here.
 *
 * Like ESI, employee PF is withheld from net pay; employer PF is an extra
 * company cost that accrues to the statutory payable and is cleared by the PF
 * (ECR) challan — it does not leave the bank at salary time.
 */

/** Ceiling in force from `from` (YYYY-MM-DD, inclusive) — newest last. */
export const PF_WAGE_CEILINGS: readonly { from: string; ceiling: number }[] = [
  { from: "2014-09-01", ceiling: 15_000 },
  { from: "2026-10-01", ceiling: 25_000 },
];
export const PF_EMPLOYEE_RATE = 0.12;   // 12%
export const PF_EMPLOYER_RATE = 0.12;   // 12% (8.33% EPS + 3.67% EPF)
export const PF_EPS_RATE      = 0.0833; // employer's pension share, on the capped wage

/** The PF wage ceiling for a salary month. Accepts a period (YYYY-MM) or a date
 *  (YYYY-MM-DD); defaults to today. */
export function pfWageCeiling(periodOrDate?: string | null): number {
  const key = (periodOrDate ?? istToday()).slice(0, 10);
  const on = key.length === 7 ? `${key}-01` : key;
  let ceiling = PF_WAGE_CEILINGS[0].ceiling;
  for (const row of PF_WAGE_CEILINGS) if (row.from <= on) ceiling = row.ceiling;
  return ceiling;
}

/** Monthly EPS cap (8.33% of the ceiling) — ₹1,250 till Sep 2026, ₹2,083 after. */
export function pfEpsCap(periodOrDate?: string | null): number {
  return Math.round(pfWageCeiling(periodOrDate) * PF_EPS_RATE);
}

/**
 * The wage PF is computed on for a month — Basic + DA (EPF Act s.6), prorated by the
 * same loss-of-pay ratio as the gross, never HRA or allowances. With no Basic on the
 * employee master the whole earned gross is used and `assumed` says so, which is what
 * payroll always did before 27 Sep 2026 — an employee nobody set up does not silently
 * get a different PF than last month.
 */
export interface PfWage { base: number; assumed: boolean; note: string }
export function pfWage(i: { gross: number; lopAmount?: number | null; basic?: number | null; da?: number | null }): PfWage {
  const gross = Math.max(0, Math.round(i.gross || 0));
  const lop = Math.min(gross, Math.max(0, Math.round(i.lopAmount ?? 0)));
  const earnedRatio = gross > 0 ? (gross - lop) / gross : 0;
  if (i.basic === null || i.basic === undefined) {
    return { base: gross - lop, assumed: true, note: "Basic not set — PF is being calculated on full gross. Enter Basic in Employee → Statutory." };
  }
  const structural = Math.max(0, Math.round(i.basic)) + Math.max(0, Math.round(i.da ?? 0));
  const base = Math.round(structural * earnedRatio);
  return {
    base, assumed: false,
    note: lop > 0 ? `Basic + DA ₹${structural.toLocaleString("en-IN")}, after LOP ₹${base.toLocaleString("en-IN")}.` : `Basic + DA ₹${structural.toLocaleString("en-IN")}.`,
  };
}

export interface PfContribution {
  applicable: boolean;
  ceiling: number;   // the ceiling used for this month (₹)
  base: number;      // PF wage the percentages apply to (capped at the ceiling)
  employee: number;  // employee share, 12% (₹)
  employer: number;  // employer share, 12% (₹)
  total: number;     // employee + employer = the PF challan portion (₹)
}

const ZERO = (base: number, ceiling: number): PfContribution => ({
  applicable: false, ceiling, base, employee: 0, employer: 0, total: 0,
});

/**
 * Compute the PF split for a month's wage.
 * @param monthlyWage the month's wage (₹). Contribution is on min(wage, ceiling).
 * @param covered     pass false to exclude an employee with no EPFO account.
 * @param period      the salary month (YYYY-MM) — decides which ceiling applies.
 *                    Omit only for an illustration as of today.
 */
export function computePf(monthlyWage: number, covered = true, period?: string | null): PfContribution {
  const ceiling = pfWageCeiling(period);
  const wage = Math.max(0, Math.round(monthlyWage || 0));
  if (!covered || wage <= 0) return ZERO(wage, ceiling);
  const base = Math.min(wage, ceiling);
  const employee = Math.round(base * PF_EMPLOYEE_RATE);
  const employer = Math.round(base * PF_EMPLOYER_RATE);
  return { applicable: true, ceiling, base, employee, employer, total: employee + employer };
}
