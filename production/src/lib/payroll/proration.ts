/**
 * Salary proration for mid-month payroll runs.
 *
 * Payroll is monthly, but if you run it before the month is over you shouldn't
 * auto-pay the days that haven't happened yet. These helpers compute how many
 * calendar days of a period have actually elapsed, and prorate the monthly
 * salary to that — the owner can still choose to pay the full month.
 */

/**
 * Calendar days of `period` (YYYY-MM) elapsed as of `todayISO` (YYYY-MM-DD).
 *  - Period already over  → full month (complete = true).
 *  - Period entirely in the future → 0 days.
 *  - Current month → day-of-month so far.
 */
export function daysElapsedInPeriod(
  period: string,
  todayISO: string,
): { elapsed: number; daysInMonth: number; complete: boolean } {
  const [py, pm] = period.split("-").map(Number);
  const daysInMonth = new Date(py, pm, 0).getDate(); // day 0 of next month = last day of this
  const todayMonth = todayISO.slice(0, 7);
  if (period < todayMonth) return { elapsed: daysInMonth, daysInMonth, complete: true };
  if (period > todayMonth) return { elapsed: 0, daysInMonth, complete: false };
  const elapsed = Math.min(Number(todayISO.slice(8, 10)) || 0, daysInMonth);
  return { elapsed, daysInMonth, complete: elapsed >= daysInMonth };
}

/** Prorate a monthly amount to `days` out of `daysInMonth` (rounded to ₹). */
export function prorateSalary(monthly: number, days: number, daysInMonth: number): number {
  if (daysInMonth <= 0) return 0;
  const d = Math.max(0, Math.min(days, daysInMonth));
  return Math.round((monthly * d) / daysInMonth);
}
