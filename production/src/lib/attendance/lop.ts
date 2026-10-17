/**
 * How many days an employee was present this month, for payroll's loss-of-pay suggestion.
 *
 * R-604 (Pardeep, 9 Oct 2026): "half day par salary kaatni hai". A day with a check-in and a
 * check-out less than `halfDayUnderHours` apart counts 0.5; every other checked-in day 1.
 * A day with no check-out counts 1 — the hours are unknown, and docking someone for a
 * forgotten tap is the owner's call (R-603 "Fix attendance"), not the app's.
 *
 * Everything else is exactly what payroll did before this file: each distinct work_date with
 * a check-in counts once, whatever day of the week it is. The two LOP bugs R-602 pinned
 * (leave spanning two months, leave on a present day) are fixed by R-780 in leaveDaysInMonth.
 */
import { addDaysISO } from "@/lib/dates/ist";
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

function checkedInByDate(rows: readonly AttendanceDayRow[], employeeId: string): Map<string, AttendanceDayRow> {
  const byDate = new Map<string, AttendanceDayRow>();
  for (const r of rows) {
    if (r.employee_id !== employeeId || !r.check_in) continue;
    // One row per (employee, work_date) is a DB unique key; keep the first if a caller
    // ever passes duplicates, so a day can never count twice.
    if (!byDate.has(r.work_date)) byDate.set(r.work_date, r);
  }
  return byDate;
}

/** R-780: present value per work_date (1, or 0.5 for a half-day) — same rule as presentSummary. */
export function presentByDate(rows: readonly AttendanceDayRow[], employeeId: string, rules: ShiftRules): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of checkedInByDate(rows, employeeId).values()) {
    out.set(r.work_date, dayStatus(r.work_date, r.check_in, r.check_out, rules).presentValue);
  }
  return out;
}

export function presentSummary(rows: readonly AttendanceDayRow[], employeeId: string, rules: ShiftRules): PresentSummary {
  const byDate = checkedInByDate(rows, employeeId);
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

export interface LeaveRow {
  employee_id: string;
  from_date: string;
  to_date: string;
  /** Leave days the owner entered — 0.5 for a half-day leave. */
  days: number;
  type: string;
}

/**
 * R-780 (Pardeep "haan", 11 Oct 2026): the leave days that belong to THIS payroll month.
 *
 * Before: every leave touching the month subtracted its whole `days` from "expected" — a
 * 28 Sep–3 Oct leave took all 5 days off October, and a leave on a day the employee was
 * present (or a Sunday/holiday) still counted. Both lowered LOP and overpaid salary.
 *
 * Now each leave is walked day by day over its own working days (`isWorkingDate`, the same
 * Sunday + holiday rule payroll's "expected" uses). Each working day takes up to 1 of the
 * leave's `days`, so a single-day 0.5 leave is half a day. A day counts for this month only
 * if it is in `countedDates` (this month's working days payroll already counts as expected),
 * and only for the part of the day not already present or covered by an earlier leave — a
 * day is never more than 1 in total.
 */
export function leaveDaysInMonth(input: {
  leaves: readonly LeaveRow[];
  employeeId: string;
  countedDates: ReadonlySet<string>;
  isWorkingDate: (iso: string) => boolean;
  presentByDate: ReadonlyMap<string, number>;
}): { paidLeave: number; unpaidLeave: number } {
  const used = new Map<string, number>();
  let paidLeave = 0, unpaidLeave = 0;
  for (const l of input.leaves) {
    if (l.employee_id !== input.employeeId || l.from_date > l.to_date) continue;
    let remaining = Math.max(0, Number(l.days) || 0);
    for (let iso = l.from_date; iso <= l.to_date && remaining > 0; iso = addDaysISO(iso, 1)) {
      if (!input.isWorkingDate(iso)) continue;
      const share = Math.min(1, remaining);
      remaining -= share;
      if (!input.countedDates.has(iso)) continue;
      const room = 1 - (input.presentByDate.get(iso) ?? 0) - (used.get(iso) ?? 0);
      const take = Math.max(0, Math.min(share, room));
      if (take === 0) continue;
      used.set(iso, (used.get(iso) ?? 0) + take);
      if (l.type === "unpaid") unpaidLeave += take; else paidLeave += take;
    }
  }
  return { paidLeave, unpaidLeave };
}
