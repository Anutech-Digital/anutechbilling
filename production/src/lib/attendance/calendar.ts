/**
 * How many days in a month was somebody expected to work? (R-602)
 *
 * "Working day" used to be decided in three places with three rule sets: payroll's
 * `attendanceFor` / `lopSuggestion` / `AttendanceRegister` (Sunday + company holidays +
 * national gazetted holidays) and the reminder path (weekly off + company holidays only).
 * This is the one pure answer, written to the SAME rules payroll uses today, so payroll
 * can switch to it without any rupee changing:
 *
 *  - Range: the joining date (when it is after the 1st) or the month start, up to
 *    min(today IST, month end). A future month, or a joiner who has not joined yet, is 0.
 *  - A weekly-off day counts as a weekly off — even when it is also a holiday. A Sunday
 *    that is 15 Aug is counted ONCE, as the weekly off.
 *  - Otherwise a company holiday or a fixed national holiday (26 Jan / 15 Aug / 2 Oct,
 *    from `lib/payroll/holidays-india.ts`) is a holiday.
 *  - Everything else is an expected working day.
 *
 * Pure: no `new Date()` for "today" — the caller passes `todayIST` (use `localDateISO()`).
 */
import { utcDateISO } from "@/lib/dates/ist";
import { nationalHolidaysForYear } from "@/lib/payroll/holidays-india";
import { isoDowOf, type IsoDow } from "./working-day";

export interface ExpectedWorkingDaysInput {
  /** Month as YYYY-MM. */
  period: string;
  /** Employee joining date YYYY-MM-DD, or null/undefined when unknown. */
  joiningDate?: string | null;
  /** Today's IST date as YYYY-MM-DD. */
  todayIST: string;
  /** The tenant's `holidays.holiday_date` values (any months; others are ignored). */
  holidayDates?: readonly string[];
  /** Non-working weekdays, ISO numbers. Payroll today uses `[7]` (Sunday). */
  weeklyOffDows: readonly IsoDow[];
}

export interface ExpectedWorkingDays {
  /** Days the person was expected to check in on. */
  expected: number;
  /** Weekly-off days in the range (a holiday on a weekly off is counted here, once). */
  weeklyOffs: number;
  /** Holidays in the range that fell on a working weekday. */
  holidays: number;
}

const ZERO: ExpectedWorkingDays = { expected: 0, weeklyOffs: 0, holidays: 0 };

/** Last day of a YYYY-MM month as YYYY-MM-DD. */
function monthEndOf(year: number, month: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

/** The YYYY-MM-DD after `iso` (UTC-noon arithmetic, so no timezone slip). */
function nextDay(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return utcDateISO(d);
}

export function expectedWorkingDays(input: ExpectedWorkingDaysInput): ExpectedWorkingDays {
  const m = /^(\d{4})-(\d{2})$/.exec(input.period);
  if (!m) return ZERO;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return ZERO;

  const monthStart = `${input.period}-01`;
  const monthEnd = monthEndOf(year, month);
  const start = input.joiningDate && input.joiningDate > monthStart ? input.joiningDate : monthStart;
  const end = input.todayIST < monthEnd ? input.todayIST : monthEnd;
  if (start > end) return ZERO;

  const holidaySet = new Set<string>(input.holidayDates ?? []);
  for (const d of nationalHolidaysForYear(year)) holidaySet.add(d);

  let expected = 0, weeklyOffs = 0, holidays = 0;
  for (let iso = start; iso <= end; iso = nextDay(iso)) {
    const dow = isoDowOf(iso);
    if (dow !== null && input.weeklyOffDows.includes(dow)) weeklyOffs++;
    else if (holidaySet.has(iso)) holidays++;
    else expected++;
  }
  return { expected, weeklyOffs, holidays };
}
