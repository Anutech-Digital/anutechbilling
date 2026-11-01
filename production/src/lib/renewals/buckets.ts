/**
 * /renewals buckets — the one rule for "which subscriptions are on the renewals page, and in
 * which tab". R-1541 (18 Oct 2026): the sidebar's Renewals badge counted active subscriptions
 * renewing within 30 days (a UTC date) while the page opened on Urgent — 7 days, every status
 * but cancelled, lapsed ones included. Now the page buckets with these, the badge opens
 * ?bucket=urgent, and nav_badges() counts the urgent bucket with the same numbers
 * (lib/hooks/nav-badge-parity.test.ts reads the SQL against them).
 */
import { daysBetween } from "@/lib/utils";
import { isSplitBilled } from "@/lib/billing/instalments";
import type { BillingCycle } from "@/lib/supabase/database.types";

/** Urgent = renews within this many IST days — or has already lapsed (in grace). */
export const RENEWAL_URGENT_DAYS = 7;
/** Upcoming runs to here; Future to RENEWAL_FUTURE_DAYS. */
export const RENEWAL_UPCOMING_DAYS = 30;
export const RENEWAL_FUTURE_DAYS = 90;
/** The one status the page leaves out. */
export const RENEWAL_EXCLUDED_STATUS = "cancelled";

export type RenewalBucket = "urgent" | "upcoming" | "future";

/** Is this subscription on the renewals page at all? It needs a renewal date and must not be cancelled. */
export function onRenewalsPage(s: { status: string; renewal_date: string | null }): boolean {
  return s.renewal_date !== null && s.status !== RENEWAL_EXCLUDED_STATUS;
}

/**
 * R-2232 (Zoho audit A8): Renewals = end of commitment only. Is this a FLEX subscription's next
 * part rather than a renewal? A 1-month term billed in parts has no commitment to end — the
 * renewals cron rolls the term and the billing job raises the part's payment request (R-808,
 * R-2044). Part date today or later only: once it has passed unbilled the row is listed again
 * (Generate bills it — R-2095). A 1-month term NOT billed in parts renews by a renewal quote,
 * so it stays a renewal row. nav_badges() 'renewals' leaves out the same rows.
 */
export function isFlexNextPart(
  sub: { term_months?: number | null; billing_cycle?: string | null },
  daysUntil: number,
): boolean {
  return (sub.term_months ?? 12) <= 1
    && isSplitBilled((sub.billing_cycle ?? null) as BillingCycle | null)
    && daysUntil >= 0;
}

/** Days from today (IST calendar days) to the renewal; negative = lapsed. */
export function daysUntilRenewal(renewalDate: string, today: Date = new Date()): number {
  return daysBetween(today, renewalDate);
}

/** The bucket for that many days, or null when it is further out than Future. */
export function renewalBucket(daysUntil: number): RenewalBucket | null {
  if (daysUntil <= RENEWAL_URGENT_DAYS) return "urgent";
  if (daysUntil <= RENEWAL_UPCOMING_DAYS) return "upcoming";
  if (daysUntil <= RENEWAL_FUTURE_DAYS) return "future";
  return null;
}
