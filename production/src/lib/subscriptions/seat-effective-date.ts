/**
 * R-800 — the "Effective date" of a mid-term seat increase.
 *
 * Abhishek (staging, 10 Oct 2026): the Add seats dialog always charged from TODAY, so seats
 * that had been provisioned with Google two weeks earlier could only be billed for the days
 * left from now — the two weeks already used were never charged. The admin can now say when
 * the seats really started; the pro-rata charge (prorate(), integer paise) runs from that date.
 *
 * Allowed range, both ends inclusive:
 *   R-543 (10 Oct 2026, Abhishek): earliest = the start of the PREVIOUS term (current term start
 *              minus term_months) when the subscription already existed then, else its own
 *              start_date. A date in the previous term bills the rest of that term AND the whole
 *              current term — two lines on one quote (seatChargePlan + seatIncreaseQuote). With
 *              no start_date the subscription can't be shown to have existed, so the current
 *              term start stays the limit. Before R-543 it was always:
 *   earliest = the start of the CURRENT term — R-802: currentTermStart() (exclusive term end
 *              minus term_months, the billing schedule's rule and the same start resolveTermDays
 *              measures the term from, so the two agree). Never the stored start_date on its
 *              own: that is the FIRST sale and stays put across renewals, so on a row renewed
 *              twice it let the admin backdate into a term that ended in 2024. Also never
 *              before start_date itself (a short first term cannot be backdated before the sale).
 *   latest   = today (IST). A future date would bill days that have not been provisioned.
 *
 * Pure: the dialog uses it for the date picker's min/max, the route re-checks the body with it.
 */
import type { Subscription } from "@/lib/supabase/database.types";
import { formatDate } from "@/lib/utils";
import { currentTermStart, previousTermStart } from "@/lib/billing/subscription-schedule";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface SeatDateSub {
  start_date: string | null;
  renewal_date: string | null;
  /** R-802: required — the current term is renewal_date minus term_months (missing = 12). */
  term_months: Subscription["term_months"];
}

export interface SeatEffectiveBounds {
  /** Earliest allowed effective date — the previous term's start (R-543), never before start_date. */
  min: string;
  /** Latest allowed effective date — today. */
  max: string;
}

export function seatEffectiveBounds(sub: SeatDateSub, todayISO: string): SeatEffectiveBounds | null {
  if (!sub.renewal_date) return null;
  const today = todayISO.slice(0, 10);
  const earliest = earliestEffective(sub, today);
  /* A term that starts in the future (pre-dated renewal) leaves only today to choose. */
  return { min: earliest.date < today ? earliest.date : today, max: today };
}

/**
 * R-543: the earliest effective date and WHY it is the earliest (for the red message).
 *   - previous-term — the subscription existed before the current term: the previous term's start.
 *   - subscription  — it was sold after the previous term started: its own start_date.
 *   - term          — no start_date (cannot prove it existed earlier), or sold in this term.
 */
function earliestEffective(sub: SeatDateSub, today: string): { date: string; reason: "previous-term" | "subscription" | "term" } {
  const termStart = currentTermStart(sub) ?? today;
  const sold = sub.start_date ? sub.start_date.slice(0, 10) : null;
  if (!sold) return { date: termStart, reason: "term" };
  if (sold >= termStart) return { date: sold, reason: "term" };
  const prev = previousTermStart(sub) ?? termStart;
  return sold > prev ? { date: sold, reason: "subscription" } : { date: prev, reason: "previous-term" };
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
    const why = earliestEffective(sub, today).reason;
    const what = why === "previous-term" ? "the previous term started"
      : why === "subscription" ? "this subscription started"
      : "this term started";
    return { ok: false, message: `Effective date can't be before ${what} (${formatDate(bounds.min)}).` };
  }
  return { ok: true, date: value, backdated: value < today };
}
