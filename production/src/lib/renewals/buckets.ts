/**
 * /renewals buckets — the one rule for "which subscriptions are on the renewals page, and in
 * which tab". R-1541 (18 Oct 2026): the sidebar's Renewals badge counted active subscriptions
 * renewing within 30 days (a UTC date) while the page opened on Urgent — 7 days, every status
 * but cancelled, lapsed ones included. Now the page buckets with these, the badge opens
 * ?bucket=urgent, and nav_badges() counts the urgent bucket with the same numbers
 * (lib/hooks/nav-badge-parity.test.ts reads the SQL against them).
 */
import { daysBetween } from "@/lib/utils";

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
