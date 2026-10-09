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
import { subscriptionSchedule } from "@/lib/billing/subscription-schedule";
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
  /** Days charged for, from today. 0 or less = nothing left to charge. */
  remainingDays: number;
  /** Length of the whole term in days — prorate()'s denominator. */
  termDays: number;
  /** Last day the charge covers (inclusive), for the quote line and the sheet. */
  chargeTo: string;
  /** True when the window is the current instalment rather than the rest of the term. */
  instalmentPeriod: boolean;
}

export function seatChargeWindow(sub: SeatWindowSub, todayISO: string): SeatChargeWindow | null {
  if (!sub.renewal_date) return null;
  const today = todayISO.slice(0, 10);
  const renewal = sub.renewal_date.slice(0, 10);
  const termDays = sub.start_date ? Math.max(1, daysBetweenDates(sub.start_date, renewal)) : 365;

  if (isSplitBilled(sub.billing_cycle)) {
    const period = subscriptionSchedule(sub).find((p) => p.periodStart <= today && today < p.periodEnd);
    if (period) {
      return {
        remainingDays: daysBetweenDates(today, period.periodEnd),
        termDays,
        chargeTo: periodLastDay(period.periodEnd),
        instalmentPeriod: true,
      };
    }
  }
  return { remainingDays: daysBetweenDates(today, renewal), termDays, chargeTo: renewal, instalmentPeriod: false };
}
