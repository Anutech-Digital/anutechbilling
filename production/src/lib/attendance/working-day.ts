/**
 * Is this a day anybody is expected to check in on?
 *
 * ─── THE BUG THIS FIXES ─────────────────────────────────────────────────────
 * Reported 23 Aug 2026 — a Sunday — as "aaj kya attendance reminder ko aana chahiye kya
 * ye logical hai". It is not. `decideAttendanceReminder` had no notion of a working day:
 * grepping it for holiday / weekend / sunday / isodow returned one hit, and that was the
 * phrase "working day" inside an unrelated message.
 *
 * So the nudge went out every Sunday, and on every public holiday — even though the app
 * already stores them. `public.holidays` has held `tenant_id`, `holiday_date`, `name`
 * this whole time and nothing in the reminder path ever read it.
 *
 * ─── WHY THAT IS WORSE THAN IT SOUNDS ───────────────────────────────────────
 * A notification that arrives on the wrong day teaches people to dismiss it unread. Then
 * it stops working on the day it IS right, which is the only day it was built for. The
 * cost of a wrong reminder is not the annoyance; it is the correct one that gets ignored
 * three weeks later.
 *
 * ─── THE WEEK IS SIX DAYS HERE ──────────────────────────────────────────────
 * Confirmed by the operator: Saturday IS a working day at ANUTECH. That is a business
 * fact, not a default — Indian SMEs run six-day, five-day and alternate-Saturday weeks —
 * so it is a parameter with no default value that would be right for everyone. Passing it
 * explicitly is the point.
 */

import { FIXED_NATIONAL_HOLIDAYS } from "@/lib/payroll/holidays-india";

/** ISO day-of-week: 1 = Monday … 7 = Sunday. */
export type IsoDow = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface WorkingDayInput {
  /** IST date as YYYY-MM-DD. Use `localDateISO()` to produce it — never `new Date()`. */
  date: string;
  /**
   * The tenant's non-working weekdays, as ISO day numbers. `[7]` is a six-day week with
   * Sunday off — ANUTECH's. `[6, 7]` is a five-day week.
   *
   * No default: a wrong guess here either nags people on their day off or goes silent on
   * a day they are working, and the caller always knows which the tenant is.
   */
  weeklyOffDows: readonly IsoDow[];
  /**
   * `holidays.holiday_date` for this tenant, as YYYY-MM-DD strings.
   *
   * The fixed national gazetted holidays (26 Jan / 15 Aug / 2 Oct) are ALWAYS off on top
   * of these. They come from `lib/payroll/holidays-india.ts`, the same list payroll uses,
   * so the reminder and the salary cannot disagree about them (R-602).
   */
  holidayDates?: readonly string[];
}

export interface WorkingDayResult {
  working: boolean;
  /**
   * Why not, in the operator's words — and null when it IS a working day.
   *
   * Carried through to the reminder's `reason`, which the cron's `?dry=1` mode prints.
   * A job whose correct behaviour is usually "do nothing" cannot otherwise be told apart
   * from one that is broken.
   */
  reason: string | null;
}

const DOW_NAME: Record<IsoDow, string> = {
  1: "Monday", 2: "Tuesday", 3: "Wednesday", 4: "Thursday",
  5: "Friday", 6: "Saturday", 7: "Sunday",
};

/**
 * ISO day-of-week for a YYYY-MM-DD date string.
 *
 * Parsed as UTC noon rather than local midnight, deliberately. `new Date("2026-08-23")`
 * is midnight UTC, which in IST is already the 23rd but in a negative-offset timezone is
 * the 22nd — and a server that decides Sunday is Saturday would nudge the whole company
 * on their day off. Noon puts the instant far from either boundary.
 */
export function isoDowOf(date: string): IsoDow | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const js = d.getUTCDay();          // 0 = Sunday
  return (js === 0 ? 7 : js) as IsoDow;
}

export function isWorkingDay(input: WorkingDayInput): WorkingDayResult {
  const dow = isoDowOf(input.date);
  if (dow === null) {
    /* An unparseable date must not silently become a working day — that is how a nudge
       goes out on a Sunday because a string arrived in the wrong format. */
    return { working: false, reason: `Could not read "${input.date}" as a date, so no reminder was sent.` };
  }

  /* Holidays first: a holiday that lands on a weekend should read as the holiday, which
     is what somebody checking the log will be looking for. */
  const holiday = (input.holidayDates ?? []).includes(input.date);
  if (holiday) {
    return { working: false, reason: `${input.date} is a company holiday.` };
  }

  /* R-602: payroll never docks 26 Jan / 15 Aug / 2 Oct, so nobody is expected to check in
     on them either. Read from the payroll list, not a copy of it. */
  const national = nationalHolidayName(input.date);
  if (national) {
    return { working: false, reason: `${input.date} is ${national}, a national holiday.` };
  }

  if (input.weeklyOffDows.includes(dow)) {
    return { working: false, reason: `${DOW_NAME[dow]} is a weekly off.` };
  }

  return { working: true, reason: null };
}

/** Name of the fixed national gazetted holiday on this YYYY-MM-DD date, or null. */
export function nationalHolidayName(date: string): string | null {
  const md = date.slice(5);
  return FIXED_NATIONAL_HOLIDAYS.find((h) => h.md === md)?.name ?? null;
}

/**
 * ANUTECH's week, and the shape a tenant setting should take when one exists.
 *
 * A named constant rather than an inline `[7]`, so the day this becomes configurable
 * there is one place to look — and so a reader can see it is a decision rather than a
 * hardcoded assumption nobody checked.
 */
export const SIX_DAY_WEEK_SUNDAY_OFF: readonly IsoDow[] = [7];
