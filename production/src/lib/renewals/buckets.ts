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
 * A FLEX (monthly-commitment) subscription: a 1-month term billed in parts. R-2422 (Pardeep,
 * 3 Nov: "monthly commitment to renewal hi hoga") — it IS a renewal: listed on Renewals by its
 * next monthly billing date and counted in the tabs, tiles, forecast and sidebar badge (R-2431).
 * A 1-month term NOT billed in parts renews by a renewal quote (not flex).
 */
export function isFlexSubscription(sub: { term_months?: number | null; billing_cycle?: string | null }): boolean {
  return (sub.term_months ?? 12) <= 1 && isSplitBilled((sub.billing_cycle ?? null) as BillingCycle | null);
}

/**
 * R-2232 / R-2431: a flex subscription's NEXT part, date today or later. Its payment request is
 * raised by the billing job on that date (R-808, R-2044), so two places leave it out: Bulk
 * reminder (named in its confirm as skipped — reminders.ts bulkReminderPlan) and Payment
 * Follow-up (until the date has passed unbilled — then it is chased like any overdue renewal,
 * and Bill next part bills it, R-2095). The Renewals page and the sidebar badge list it.
 */
export function isFlexNextPart(
  sub: { term_months?: number | null; billing_cycle?: string | null },
  daysUntil: number,
): boolean {
  return isFlexSubscription(sub) && daysUntil >= 0;
}

/** R-2431: why Bulk reminder skips a flex part — said in its confirm. */
export const FLEX_PART_SKIP_REASON = "monthly (flex) — its payment request goes out on its billing date";

/**
 * R-2431: is this row in the sidebar Renewals badge? The badge = the Renewals page's Overdue +
 * ≤7 days tabs (classify.ts + queue.ts queueTabs), row for row, less the Won't renew rows:
 *   - Won't renew (auto_renew off): never — R-2225, not a renewal to chase (the ≤7 days tab
 *     still lists a running one with its Non-renewing chip);
 *   - otherwise: date ≤ today + 7, except a past-date renewal whose renewal quote is paid
 *     (R-2403 renewedPaid) unless its service is stopped;
 *   - a flex subscription counts like any other row (R-2422).
 * nav_badges() runs the same rule in SQL (lib/hooks/nav-badge-parity.test.ts; SQL test
 * supabase/tests/r2431_nav_badges_tabs.test.sql).
 */
export function inRenewalsBadge(
  sub: { status: string; renewal_date: string | null; auto_renew?: boolean | null; renewal_state?: string | null },
  daysUntil: number,
  renewalQuotePaid: boolean,
): boolean {
  if (!onRenewalsPage(sub) || daysUntil > RENEWAL_URGENT_DAYS) return false;
  if (sub.auto_renew === false) return false;
  const stopped = sub.renewal_state === "suspended" || sub.status === "suspended";
  return !(daysUntil < 0 && !stopped && renewalQuotePaid);
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
