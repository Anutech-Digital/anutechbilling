/**
 * How many days an employee was present this month, for payroll's loss-of-pay suggestion.
 *
 * R-604 (Pardeep, 9 Oct 2026): "half day par salary kaatni hai". A day with a check-in and a
 * check-out less than `halfDayUnderHours` apart counts 0.5; every other checked-in day 1.
 * A day with no check-out counts 1 — the hours are unknown, and docking someone for a
 * forgotten tap is the owner's call (R-603 "Fix attendance"), not the app's.
 *
 * Everything else is exactly what payroll did before this file: each distinct work_date with
 * a check-in counts once, whatever day of the week it is. The two known LOP bugs R-602
 * pinned (leave spanning two months, leave on a present day) are deliberately NOT changed
 * here — that is a separate money decision.
 */
import { dayStatus, type ShiftRules } from "./shift";

export interface AttendanceDayRow {
  employee_id: string;
  work_date: string;
  check_in: string | null;
  check_out: string | null;
}

export interface PresentSummary {
  /** Present days, halves included — e.g. 21.5. */
  present: number;
  halfDays: number;
  lateDays: number;
  noCheckOutDays: number;
}

export function presentSummary(rows: readonly AttendanceDayRow[], employeeId: string, rules: ShiftRules): PresentSummary {
  const byDate = new Map<string, AttendanceDayRow>();
  for (const r of rows) {
    if (r.employee_id !== employeeId || !r.check_in) continue;
    // One row per (employee, work_date) is a DB unique key; keep the first if a caller
    // ever passes duplicates, so a day can never count twice.
    if (!byDate.has(r.work_date)) byDate.set(r.work_date, r);
  }
  let present = 0, halfDays = 0, lateDays = 0, noCheckOutDays = 0;
  for (const r of byDate.values()) {
    const s = dayStatus(r.work_date, r.check_in, r.check_out, rules);
    present += s.presentValue;
    if (s.halfDay) halfDays++;
    if (s.late) lateDays++;
    if (s.noCheckOut) noCheckOutDays++;
  }
  return { present, halfDays, lateDays, noCheckOutDays };
}

/**
 * Loss-of-pay days from attendance, as payroll suggests them. Same arithmetic as before
 * R-604; `present` may now hold a half.
 */
export function suggestedLopDays(input: {
  expected: number; present: number; paidLeave: number; unpaidLeave: number;
}): { absent: number; lopDays: number } {
  const absent = Math.max(0, input.expected - input.present - input.paidLeave - input.unpaidLeave);
  return { absent, lopDays: absent + input.unpaidLeave };
}
