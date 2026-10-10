/**
 * R-800 — the "Effective date" of a mid-term seat increase.
 *
 * Abhishek (staging, 10 Oct 2026): the Add seats dialog always charged from TODAY, so seats
 * that had been provisioned with Google two weeks earlier could only be billed for the days
 * left from now — the two weeks already used were never charged. The admin can now say when
 * the seats really started; the pro-rata charge (prorate(), integer paise) runs from that date.
 *
 * Allowed range, both ends inclusive:
 *   earliest = the start of the CURRENT term (start_date; without one, renewal − 365 days —
 *              the same fallback resolveTermDays uses for the term length, so the two agree)
 *   latest   = today (IST). A future date would bill days that have not been provisioned.
 *
 * Pure: the dialog uses it for the date picker's min/max, the route re-checks the body with it.
 */
import { addDaysISO } from "@/lib/dates/ist";
import { formatDate } from "@/lib/utils";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface SeatDateSub {
  start_date: string | null;
  renewal_date: string | null;
}

export interface SeatEffectiveBounds {
  /** Earliest allowed effective date — the current term's start. */
  min: string;
  /** Latest allowed effective date — today. */
  max: string;
}

export function seatEffectiveBounds(sub: SeatDateSub, todayISO: string): SeatEffectiveBounds | null {
  if (!sub.renewal_date) return null;
  const today = todayISO.slice(0, 10);
  const termStart = sub.start_date ? sub.start_date.slice(0, 10) : addDaysISO(sub.renewal_date, -365);
  /* A term that starts in the future (pre-dated renewal) leaves only today to choose. */
  return { min: termStart < today ? termStart : today, max: today };
}

export type SeatEffectiveCheck =
  | { ok: true; date: string; backdated: boolean }
  | { ok: false; message: string };

/**
 * Validate an effective date. `undefined`/empty means today — the old behaviour, and what
 * a customer's approved seat request still uses.
 */
export function checkSeatEffectiveDate(
  raw: string | null | undefined,
  sub: SeatDateSub,
  todayISO: string,
): SeatEffectiveCheck {
  const today = todayISO.slice(0, 10);
  const value = (raw ?? "").trim();
  if (!value) return { ok: true, date: today, backdated: false };

  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))
      || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    return { ok: false, message: "Effective date is not a valid date. Pick a date from the calendar." };
  }
  const bounds = seatEffectiveBounds(sub, today);
  if (!bounds) return { ok: false, message: "This subscription has no renewal date — extend or renew it first." };
  if (value > bounds.max) {
    return { ok: false, message: "Effective date can't be in the future. Pick today or an earlier date." };
  }
  if (value < bounds.min) {
    return { ok: false, message: `Effective date can't be before this term started (${formatDate(bounds.min)}).` };
  }
  return { ok: true, date: value, backdated: value < today };
}
