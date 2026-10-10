/**
 * Office hours → what one attendance day means: late, left early, hours, half-day.
 *
 * R-604. Rules from Pardeep, 9 Oct 2026, the same for every employee:
 *   • office hours 10:00 to 18:00 IST
 *   • a check-in after 10:15 is LATE — shown only, never docked
 *   • under 4 hours between check-in and check-out is a HALF-DAY — payroll's loss-of-pay
 *     suggestion counts it as 0.5 present ("half day par salary kaatni hai")
 *
 * They live on attendance_settings so another workspace can set its own; DEFAULT_SHIFT is
 * what a workspace with no row gets.
 *
 * Every clock reading is IST wall-clock, worked out from the instant — never the browser's
 * or the server's timezone. Cloud Run runs in UTC, so `new Date(x).getHours()` there is
 * 5½ hours off and would mark the whole office late.
 */

export interface ShiftRules {
  /** "HH:MM", IST. */
  shiftStart: string;
  /** "HH:MM", IST. */
  shiftEnd: string;
  /** Minutes after shiftStart that still count as on time. 15 → 10:15 is on time, 10:16 late. */
  lateGraceMinutes: number;
  /** Fewer worked hours than this (with a check-out) is a half-day. Exactly this is a full day. */
  halfDayUnderHours: number;
}

export const DEFAULT_SHIFT: ShiftRules = {
  shiftStart: "10:00",
  shiftEnd: "18:00",
  lateGraceMinutes: 15,
  halfDayUnderHours: 4,
};

export interface DayStatus {
  present: boolean;
  late: boolean;
  /** Minutes after shiftStart (not after the grace) — "late by 27 min" at 10:27. 0 when on time. */
  lateByMinutes: number;
  leftEarly: boolean;
  leftEarlyByMinutes: number;
  /** null when there is no check-out — the hours are unknown, not zero. */
  workedMinutes: number | null;
  halfDay: boolean;
  /** Checked in, never checked out. Counted as a full day; the owner fixes the time. */
  noCheckOut: boolean;
  /** What payroll's loss-of-pay suggestion counts for this day: 0, 0.5 or 1. */
  presentValue: 0 | 0.5 | 1;
}

const IST_OFFSET_MS = 330 * 60 * 1000;

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Minutes since IST midnight of `workDate` (YYYY-MM-DD) for an instant. A check-out after
 * midnight reads past 1440 rather than wrapping to the morning.
 */
export function istMinuteOfDay(instant: string, workDate: string): number {
  const dayStartUtcMs = Date.parse(`${workDate}T00:00:00Z`) - IST_OFFSET_MS;
  return Math.floor((Date.parse(instant) - dayStartUtcMs) / 60000);
}

export function dayStatus(
  workDate: string,
  checkIn: string | null,
  checkOut: string | null,
  rules: ShiftRules,
): DayStatus {
  if (!checkIn) {
    return {
      present: false, late: false, lateByMinutes: 0, leftEarly: false, leftEarlyByMinutes: 0,
      workedMinutes: null, halfDay: false, noCheckOut: false, presentValue: 0,
    };
  }

  const start = hhmmToMinutes(rules.shiftStart);
  const end = hhmmToMinutes(rules.shiftEnd);
  const inMin = istMinuteOfDay(checkIn, workDate);
  const late = inMin > start + rules.lateGraceMinutes;

  const outMin = checkOut ? istMinuteOfDay(checkOut, workDate) : null;
  const workedMinutes = outMin === null ? null : Math.max(0, outMin - inMin);
  const leftEarly = outMin !== null && outMin < end;
  const halfDay = workedMinutes !== null && workedMinutes < rules.halfDayUnderHours * 60;

  return {
    present: true,
    late,
    lateByMinutes: late ? inMin - start : 0,
    leftEarly,
    leftEarlyByMinutes: leftEarly && outMin !== null ? end - outMin : 0,
    workedMinutes,
    halfDay,
    noCheckOut: outMin === null,
    presentValue: halfDay ? 0.5 : 1,
  };
}

/** Columns of attendance_settings this module reads. Postgres `time` arrives as "HH:MM:SS". */
export interface ShiftSettingsRow {
  shift_start: string | null;
  shift_end: string | null;
  late_grace_minutes: number | null;
  half_day_under_hours: number | null;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)/;

/** A settings row → rules. Anything missing or unreadable takes the default, field by field. */
export function parseShiftRules(row: Partial<ShiftSettingsRow> | null | undefined): ShiftRules {
  const time = (v: string | null | undefined, fallback: string) => {
    const m = typeof v === "string" ? HHMM.exec(v) : null;
    return m ? `${m[1]}:${m[2]}` : fallback;
  };
  const grace = row?.late_grace_minutes;
  const half = row?.half_day_under_hours;
  return {
    shiftStart: time(row?.shift_start, DEFAULT_SHIFT.shiftStart),
    shiftEnd: time(row?.shift_end, DEFAULT_SHIFT.shiftEnd),
    lateGraceMinutes: typeof grace === "number" && grace >= 0 && grace <= 240 ? grace : DEFAULT_SHIFT.lateGraceMinutes,
    halfDayUnderHours: typeof half === "number" && half > 0 && half <= 12 ? half : DEFAULT_SHIFT.halfDayUnderHours,
  };
}

/** "8h 05m" — for a worked-minutes figure. */
export function formatWorked(minutes: number): string {
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Owner input from the settings form → rules, or a reason it was refused. The DB has the
 * same check (attendance_settings_shift_check); this gives the owner a sentence instead
 * of a constraint name.
 */
export function validateShiftInput(input: {
  shiftStart?: unknown; shiftEnd?: unknown; lateGraceMinutes?: unknown; halfDayUnderHours?: unknown;
}): { ok: true; rules: ShiftRules } | { ok: false; error: string } {
  const start = typeof input.shiftStart === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.shiftStart) ? input.shiftStart : null;
  const end = typeof input.shiftEnd === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.shiftEnd) ? input.shiftEnd : null;
  if (!start || !end) return { ok: false, error: "Enter office hours as HH:MM, e.g. 10:00 and 18:00." };
  if (hhmmToMinutes(end) <= hhmmToMinutes(start)) {
    return { ok: false, error: "Office end time must be after the start time." };
  }
  const grace = Number(input.lateGraceMinutes);
  if (!Number.isInteger(grace) || grace < 0 || grace > 240) {
    return { ok: false, error: "Late after: enter 0 to 240 minutes." };
  }
  const half = Number(input.halfDayUnderHours);
  if (!Number.isFinite(half) || half <= 0 || half > 12) {
    return { ok: false, error: "Half-day under: enter hours between 0.5 and 12." };
  }
  return { ok: true, rules: { shiftStart: start, shiftEnd: end, lateGraceMinutes: grace, halfDayUnderHours: Math.round(half * 100) / 100 } };
}

/** A late / early gap for a tag: "27 min" under an hour, "4h 25m" from an hour up. */
export function formatGap(minutes: number): string {
  return minutes < 60 ? `${minutes} min` : formatWorked(minutes);
}
