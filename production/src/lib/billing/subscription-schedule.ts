/**
 * A subscription's billing schedule — the bridge from a stored row to `schedule.ts`.
 *
 * Kept apart from schedule.ts so the arithmetic stays pure and testable without a
 * database shape in it, and so this file can carry the one thing that is genuinely
 * about THIS schema: the term amount is not stored, it is derived from `mrr`.
 *
 * ─── WHY mrr × 12 AND NOT A STORED TERM PRICE ───────────────────────────────
 * `subscriptions` has no term-total column — it has `mrr`, which is what every other
 * revenue figure in this app is built on. Deriving the term from it keeps this
 * schedule consistent with the dashboard, the renewals list and the P&L. Inventing a
 * separate term price here would give the same subscription two different values
 * depending on which screen you were looking at, which is the failure this codebase
 * has already paid for three times over.
 *
 * A multi-year term is mrr × term_months — NOT mrr × 12 × years-with-a-discount.
 * Any multi-year discount is already inside the agreed mrr.
 */
import type { Subscription } from "@/lib/supabase/database.types";
import { buildBillingSchedule, upcomingBillings, nextTermStart, type BillingPeriod } from "./schedule";
import { addDaysISO } from "@/lib/dates/ist";

/** How far ahead the renewal cron shows what is coming. Matches the T-30 heads-up. */
export const BILLING_LOOKAHEAD_DAYS = 30;

type ScheduleFields = Pick<Subscription, "mrr" | "billing_cycle" | "term_months"> & {
  start_date: string | null;
  renewal_date: string | null;
};

/**
 * The schedule for the CURRENT term.
 *
 * Anchored on `renewal_date` minus the term rather than on `start_date`: a
 * subscription renewed three times has a start_date from years ago, and laying the
 * schedule from there would bill a term that ended in 2023. Falls back to start_date
 * only when there is no renewal date at all, and returns an empty schedule rather
 * than guessing when there is neither.
 *
 * `renewal_date` is the INCLUSIVE last covered day since 11 Sep 2026, so the term's
 * start is measured from the day AFTER it — see the block above nextTermStart in
 * schedule.ts. Subtracting the months from the stored date directly would start the
 * term one day early and bill a day the customer never had.
 */
export function subscriptionSchedule(sub: ScheduleFields): BillingPeriod[] {
  const termMonths = Math.max(1, sub.term_months ?? 12);
  const cycle = sub.billing_cycle ?? "yearly";
  const termAmount = Math.max(0, Math.round((sub.mrr ?? 0) * termMonths));

  const start = currentTermStart(sub);
  if (!start || termAmount <= 0) return [];

  return buildBillingSchedule({ startDate: start, termMonths, cycle, termAmount });
}

/**
 * R-802 (10 Oct 2026): the first day of the CURRENT term — the exclusive term end
 * (followingTermStart) minus term_months. The rule the schedule above lays its
 * instalments from, exported so seat pro-rata and the seat effective-date check use it too.
 *
 * start_date is the day the subscription was FIRST sold and is never moved on renewal
 * (record_payment only rolls renewal_date forward), so counting a term from it on a row
 * renewed twice spans three years: start 15 Sep 2023 → renewal 14 Sep 2026 was a
 * 1,096-day "term", a +1 seat charge came out at a third of the right amount, and a
 * backdated effective date could reach into 2023. Falls back to start_date only when
 * there is no renewal date; null when there is neither. term_months null = 12.
 */
export function currentTermStart(sub: Pick<ScheduleFields, "term_months" | "start_date" | "renewal_date">): string | null {
  if (sub.renewal_date) return addMonths(followingTermStart(sub), -Math.max(1, sub.term_months ?? 12));
  return sub.start_date ? sub.start_date.slice(0, 10) : null;
}

/**
 * The NEXT term — what the customer is being asked to renew into.
 *
 * Begins the day AFTER the stored date. Passing `renewal_date` in as the start would
 * make term two open on the last day of term one — one day sold twice, on every
 * renewal of every subscription.
 */
export function nextTermSchedule(sub: ScheduleFields): BillingPeriod[] {
  if (!sub.renewal_date) return [];
  const termMonths = Math.max(1, sub.term_months ?? 12);
  const termAmount = Math.max(0, Math.round((sub.mrr ?? 0) * termMonths));
  if (termAmount <= 0) return [];
  return buildBillingSchedule({
    startDate: followingTermStart(sub),
    termMonths,
    cycle: sub.billing_cycle ?? "yearly",
    termAmount,
  });
}

/**
 * R-451 (9 Oct 2026): the first day of the term AFTER the current one.
 *
 * Two shapes of `renewal_date` are in the table today, and the schedule must read both:
 *   - INCLUSIVE last day (the rule since 11 Sep 2026; "Correct details", imports):
 *       start 20 Oct 2025 → renewal 19 Oct 2026 → next term starts 20 Oct 2026.
 *   - ANNIVERSARY (what record_payment still writes for a sale paid through a quote):
 *       start 8 Oct 2026 → renewal 8 Oct 2027 → next term starts 8 Oct 2027.
 * Reading an anniversary row as inclusive moved every date one day later — Abhishek's
 * Scenario 7: "THIS TERM 9 Oct 2026" for a subscription that started on 8 Oct.
 *
 * A row is an anniversary row when its renewal_date is exactly a whole number of terms
 * after its start_date. An inclusive row is always one day short of that, so the two
 * cannot be confused. With no start_date the stored rule (inclusive) is used.
 */
export function followingTermStart(sub: Pick<ScheduleFields, "term_months" | "start_date" | "renewal_date">): string {
  const renewal = (sub.renewal_date ?? "").slice(0, 10);
  if (isAnniversaryRenewal(sub)) return renewal;
  return nextTermStart(renewal);
}

/**
 * R-451: which term_start the billing cron must file this term's instalments under.
 *
 * Before R-451 an anniversary row's term was read as starting ONE DAY LATER, and the
 * cron may already have written that term's instalments under that later term_start.
 * term_start is part of the unique key, so switching to the corrected date would insert
 * a second set of instalments for the same term — a customer invoiced twice. When rows
 * exist under the old (one-day-later) key and none under the corrected one, keep the old
 * key for this term; the next term is filed under the corrected date.
 */
export function billingTermStart(corrected: string, existingTermStarts: readonly string[]): string {
  if (existingTermStarts.includes(corrected)) return corrected;
  const legacy = addDaysISO(corrected, 1);
  return existingTermStarts.includes(legacy) ? legacy : corrected;
}

/** renewal_date = start_date + N whole terms (N ≥ 1) — see followingTermStart. */
export function isAnniversaryRenewal(sub: Pick<ScheduleFields, "term_months" | "start_date" | "renewal_date">): boolean {
  if (!sub.start_date || !sub.renewal_date) return false;
  const start = sub.start_date.slice(0, 10);
  const renewal = sub.renewal_date.slice(0, 10);
  if (renewal <= start) return false;
  const termMonths = Math.max(1, sub.term_months ?? 12);
  for (let n = 1; n <= 100; n++) {
    const d = addMonths(start, n * termMonths);
    if (d === renewal) return true;
    if (d > renewal) return false;
  }
  return false;
}

/**
 * What falls due in the next `days` — current term first, then the next.
 *
 * Both terms are considered because the interesting window is exactly the one that
 * straddles a renewal: at T-30 the useful answer is "the renewal instalment", which
 * lives in the NEXT term and would be invisible if only the current one was scanned.
 */
export function upcomingForSubscription(
  sub: ScheduleFields,
  todayISO: string,
  days: number = BILLING_LOOKAHEAD_DAYS,
): BillingPeriod[] {
  return [
    ...upcomingBillings(subscriptionSchedule(sub), todayISO, days),
    ...upcomingBillings(nextTermSchedule(sub), todayISO, days),
  ];
}

/** Re-implemented locally to keep schedule.ts free of imports from here. */
function addMonths(dateISO: string, months: number): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  const idx = (m - 1) + months;
  const year = y + Math.floor(idx / 12);
  const mon = ((idx % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, mon + 1, 0)).getUTCDate();
  return `${year}-${String(mon + 1).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
}
