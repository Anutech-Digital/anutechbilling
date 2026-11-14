/**
 * R-2699 — salary revision / increment with an effective-from MONTH.
 *
 * Storage: public.employee_salary_revisions (migration r2699_salary_revisions). Each row keeps the
 * new structure AND the one it replaced (prev_*). The employees row holds the salary GOING
 * FORWARD (the latest revision). So the salary in force for month M is:
 *   the prev_* of the earliest revision whose month is AFTER M; none → the employees row.
 * The SQL function public.employee_salary_arrears uses the same rule (tested on the same numbers
 * in supabase/tests/r2699_salary_revision.test.sql).
 *
 * Booked salary months are never changed by a revision. A revision dated into an already-booked
 * month gives ARREARS: per booked month, earned (gross − LOP) × new / old − earned, where old is the
 * salary in force when that month was booked. The next Pay salary offers them as one explicit line
 * (pay_salary_with_arrears), booked in the PAYING month.
 */
import { ctcFromEmployee, employeeCtcOptions, type CtcPolicy } from "./ctc";
import { ESI_WAGE_CEILING } from "./esi";
import { periodLabelShort } from "./period-label";

export interface SalaryStructure {
  monthly_gross: number;
  basic_monthly: number | null;
  da_monthly: number | null;
}

export interface SalaryRevision {
  id: string;
  employee_id: string;
  /** First day of the month the new salary starts (YYYY-MM-01). */
  effective_from: string;
  monthly_gross: number;
  basic_monthly: number | null;
  da_monthly: number;
  prev_monthly_gross: number;
  prev_basic_monthly: number | null;
  prev_da_monthly: number;
  annual_ctc: number | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

export function revisionMonth(r: { effective_from: string }): string {
  return r.effective_from.slice(0, 7);
}

/** The salary structure in force for `period` (YYYY-MM), and the revision that set it (null = the
 *  salary from before any revision, or no revisions at all). */
export function salaryInForce(
  employee: SalaryStructure,
  revisions: readonly SalaryRevision[],
  period: string,
): SalaryStructure & { revision: SalaryRevision | null } {
  const sorted = [...revisions].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  const next = sorted.find((r) => revisionMonth(r) > period);
  const setBy = [...sorted].reverse().find((r) => revisionMonth(r) <= period) ?? null;
  if (next) {
    return {
      monthly_gross: next.prev_monthly_gross,
      basic_monthly: next.prev_basic_monthly,
      da_monthly: next.prev_da_monthly,
      revision: setBy,
    };
  }
  return {
    monthly_gross: employee.monthly_gross,
    basic_monthly: employee.basic_monthly,
    da_monthly: employee.da_monthly,
    revision: setBy,
  };
}

/** Revisions grouped by employee, each list sorted by month — group once, look up per row. */
export function revisionsByEmployee(revisions: readonly SalaryRevision[]): Map<string, SalaryRevision[]> {
  const out = new Map<string, SalaryRevision[]>();
  for (const r of revisions) {
    const list = out.get(r.employee_id);
    if (list) list.push(r); else out.set(r.employee_id, [r]);
  }
  for (const list of out.values()) list.sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  return out;
}

/** Arrears for one month booked at `oldGross` when the salary in force is now `newGross`.
 *  `earned` = the booked gross − LOP (incentive excluded). Whole rupees; never negative. */
export function arrearsForMonth(earned: number, oldGross: number, newGross: number): number {
  if (!(oldGross > 0) || !(earned > 0) || !(newGross > oldGross)) return 0;
  return Math.round((earned * newGross) / oldGross) - earned;
}

export interface ArrearsMonth { period: string; arrears: number }
export interface ArrearsSummary {
  due: number;
  paid: number;
  /** What the next Pay salary may book — never below 0. */
  outstanding: number;
  /** Arrears already paid beyond what is due now (a month redone at the new salary). Shown, never auto-deducted. */
  overpaid: number;
  months: ArrearsMonth[];
  monthsLabel: string;
  /** The latest month with arrears — they can only be paid with a LATER month's salary. */
  lastMonth: string | null;
}

/** Arrears may ride on this salary month: something is due and the month is after every arrears month. */
export function arrearsPayableIn(summary: ArrearsSummary | null, period: string): boolean {
  return Boolean(summary && summary.outstanding > 0 && (!summary.lastMonth || period > summary.lastMonth));
}

export function arrearsSummary(months: readonly ArrearsMonth[], paid: number): ArrearsSummary {
  const due = months.reduce((s, m) => s + Math.max(0, m.arrears), 0);
  const p = Math.max(0, paid);
  const withArrears = months.filter((m) => m.arrears > 0);
  return {
    due, paid: p,
    outstanding: Math.max(0, due - p),
    overpaid: Math.max(0, p - due),
    months: withArrears,
    monthsLabel: withArrears.map((m) => periodLabelShort(m.period)).join(", "),
    lastMonth: withArrears.reduce<string | null>((max, m) => (max === null || m.period > max ? m.period : max), null),
  };
}

/** The new structure for `newGross`, keeping the Basic / DA share of the current gross. */
export function scaledStructure(current: SalaryStructure, newGross: number): SalaryStructure {
  const g = Math.max(0, Math.round(newGross || 0));
  const old = current.monthly_gross;
  if (!(old > 0)) return { monthly_gross: g, basic_monthly: current.basic_monthly, da_monthly: current.da_monthly ?? 0 };
  const scale = (v: number | null) => (v === null ? null : Math.round((v * g) / old));
  return {
    monthly_gross: g,
    basic_monthly: scale(current.basic_monthly),
    da_monthly: scale(current.da_monthly ?? 0) ?? 0,
  };
}

/** Switches the CTC follows (the employee's own Statutory & Access settings). */
export interface CtcSwitches extends SalaryStructure {
  pf_applicable: boolean;
  esi_applicable: boolean;
  pf_full_wage?: boolean | null;
}

/** The largest whole-rupee monthly gross whose CTC (ctcFromEmployee — the same CTC the profile
 *  shows) is at most `annualCtc`, keeping the employee's Basic / DA share and PF / ESI switches.
 *  R-2770: with the company payroll policy (gratuity / CTC includes employer; missing = defaults). */
export function grossForAnnualCtc(annualCtc: number, current: CtcSwitches, asOf: string, policy?: CtcPolicy | null): number {
  const target = Math.round(annualCtc || 0);
  if (target <= 0) return 0;
  const opts = employeeCtcOptions(policy, asOf);
  const ctcOf = (g: number) => ctcFromEmployee({ ...current, ...scaledStructure(current, g) }, opts).annualCtc;
  /* CTC rises with gross on each side of the ESI ceiling, but drops just above it (employer ESI
     stops), so search the two pieces separately and take the larger gross that fits. */
  const largestFitting = (lo: number, hi: number): number | null => {
    if (lo > hi || ctcOf(lo) > target) return null;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (ctcOf(mid) <= target) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  const top = Math.ceil(target / 12);
  if (current.esi_applicable && top > ESI_WAGE_CEILING) {
    return largestFitting(ESI_WAGE_CEILING + 1, top) ?? largestFitting(0, ESI_WAGE_CEILING) ?? 0;
  }
  return largestFitting(0, top) ?? 0;
}

/** "2026-12" → "2027-01". */
export function nextPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** Default "effective from": the month after the last booked one, but never before this month. */
export function defaultEffectiveMonth(todayIso: string, lastBookedPeriod: string | null): string {
  const thisMonth = todayIso.slice(0, 7);
  if (!lastBookedPeriod || lastBookedPeriod < thisMonth) return thisMonth;
  return nextPeriod(lastBookedPeriod);
}

/**
 * R-2722 (R-2699 staging note): the line under Revise salary for months already booked from the
 * chosen month on. "Booked" — Pay salary books a month; it is paid only when a bank line is
 * linked (salary-status.ts), so "already paid" was wrong for a booked-but-unpaid month. Months
 * booked before salary revisions existed (salary_in_force null) are named apart: their old
 * salary is inferred from today's salary / the revision history, so the owner should check it.
 */
export function revisionBookedNote(
  bookedFrom: readonly { period: string; salary_in_force: number | null }[],
  label: (period: string) => string,
): { booked: string; legacy: string | null } {
  const one = bookedFrom.length === 1;
  const booked = `${bookedFrom.map((p) => label(p.period)).join(", ")} ${one ? "is" : "are"} already booked at the old salary — ${one ? "it stays" : "they stay"} as booked.`;
  const legacy = bookedFrom.filter((p) => p.salary_in_force == null);
  return {
    booked,
    legacy: legacy.length === 0 ? null
      : `${legacy.map((p) => label(p.period)).join(", ")} ${legacy.length === 1 ? "was" : "were"} booked before salary revisions — check the old salary used for ${legacy.length === 1 ? "it" : "them"}.`,
  };
}
