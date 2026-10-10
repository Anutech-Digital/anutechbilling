/**
 * R-527 — how many days a mid-term seat increase is charged for, now.
 *
 * A subscription billed YEARLY has been paid to its renewal date, so new seats are charged
 * pro-rata to the renewal date (unchanged). A subscription billed in INSTALMENTS (annual
 * commitment, billed monthly / quarterly / half-yearly) has been paid only to the end of
 * the CURRENT instalment: charging the new seats to the renewal date asked the customer for
 * three quarters that are not due — on a07416e3 (quarterly, 9 Oct 2026) "+1 seat" wanted
 * the whole year. Those later quarters already carry the new seats: the billing run re-syncs
 * every un-invoiced instalment to the new MRR (lib/billing/sync-instalments.server.ts).
 *
 * So for a split-billed subscription the charge runs to the end of the current period, at
 * the same annual per-seat rate: annual × days-left-in-period / days-in-term. prorate()
 * takes exactly that shape (remainingDays over termDays), so nothing else changes.
 *
 * Pure: the add-seats route, the customer-request approval and both previews call it.
 */
import type { Subscription } from "@/lib/supabase/database.types";
import { isSplitBilled } from "@/lib/billing/instalments";
import { subscriptionSchedule, followingTermStart } from "@/lib/billing/subscription-schedule";
import { periodLastDay } from "@/lib/billing/schedule";
import { daysBetweenDates } from "./proration";

export interface SeatWindowSub {
  mrr: number;
  billing_cycle: Subscription["billing_cycle"];
  term_months: Subscription["term_months"];
  start_date: string | null;
  renewal_date: string | null;
}

export interface SeatChargeWindow {
  /** Days charged for, from the effective date (today by default). 0 or less = nothing left to charge. */
  remainingDays: number;
  /** Length of the whole term in days — prorate()'s denominator. */
  termDays: number;
  /** Last day the charge covers (inclusive), for the quote line and the sheet. */
  chargeTo: string;
  /** True when the window is the current instalment rather than the rest of the term. */
  instalmentPeriod: boolean;
}

/**
 * R-800: `effectiveISO` is the date the new seats were actually provisioned — today by
 * default, earlier when the admin backdates it. WHICH instalment we are in is still decided
 * by today (that is the instalment invoiced at the old seat count before the change), but
 * the days charged run FROM the effective date, so a backdated add also covers the days the
 * seats were already in use. Callers validate the date first (seat-effective-date.ts).
 */
export function seatChargeWindow(sub: SeatWindowSub, todayISO: string, effectiveISO?: string): SeatChargeWindow | null {
  if (!sub.renewal_date) return null;
  const today = todayISO.slice(0, 10);
  const from = (effectiveISO ?? todayISO).slice(0, 10);
  /* chargeTo stays the stored renewal date — the inclusive last covered day on the quote line. */
  const renewal = sub.renewal_date.slice(0, 10);
  /* R-801: days are counted to the EXCLUSIVE term end, never to renewal_date directly. */
  const termEnd = followingTermStart(sub);
  const termDays = sub.start_date ? Math.max(1, daysBetweenDates(sub.start_date, termEnd)) : 365;

  if (isSplitBilled(sub.billing_cycle)) {
    const period = subscriptionSchedule(sub).find((p) => p.periodStart <= today && today < p.periodEnd);
    if (period) {
      return {
        remainingDays: daysBetweenDates(from, period.periodEnd),
        termDays,
        chargeTo: periodLastDay(period.periodEnd),
        instalmentPeriod: true,
      };
    }
  }
  return { remainingDays: daysBetweenDates(from, termEnd), termDays, chargeTo: renewal, instalmentPeriod: false };
}

/**
 * R-801: the EXCLUSIVE end of the current term — the first day the customer has NOT paid for.
 *
 * Since 11 Sep 2026 `renewal_date` is the inclusive last covered day (1 Apr 2026 → 31 Mar
 * 2027), but older rows paid through a quote still hold the anniversary (8 Oct 2026 → 8 Oct
 * 2027). Counting days straight to renewal_date made an inclusive-end year 364 days and never
 * charged its last day: 25 Sep 2026 on a 1 Apr–31 Mar term was 187/364 instead of 188/365,
 * and on the renewal day itself nothing at all. followingTermStart reads both shapes.
 * The add-seats server path and the seat-request verdict use this for "has the term ended".
 */
export function seatTermEnd(sub: Pick<SeatWindowSub, "term_months" | "start_date" | "renewal_date">): string | null {
  if (!sub.renewal_date) return null;
  return followingTermStart(sub);
}
