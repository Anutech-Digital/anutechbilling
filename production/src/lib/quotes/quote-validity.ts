/**
 * R-814 — how long a quote stays open.
 *
 * There is no per-tenant setting: every new quote starts at 30 days — the quote builder's
 * "Valid for (days)" default (quote-builder.tsx), the PDF's validityDays and the send email's
 * fallback. add-seats-validity.test.ts pins the builder default to this constant.
 *
 * Add-seats quotes used to expire at renewal + grace days. Staging, 10 Oct 2026:
 * Q-5F40-27-0012 said "Valid until 7 Oct 2027 / Quote validity: 362 days" — but a pro-rata
 * price is right only for the day it was worked out; a year later it charges for days that
 * have already gone.
 */
import { addDaysISO } from "@/lib/dates/ist";

export const DEFAULT_QUOTE_VALIDITY_DAYS = 30;

/**
 * Expiry of an add-seats quote: the normal validity from today, but never past the last
 * day the quote charges for (renewal, or the current instalment's end) — after that the
 * quote's price is for a period that has ended. Never before today.
 */
export function addSeatsQuoteExpiry(todayISO: string, lastChargedDay: string): string {
  const today = todayISO.slice(0, 10);
  const normal = addDaysISO(today, DEFAULT_QUOTE_VALIDITY_DAYS);
  const cap = lastChargedDay.slice(0, 10);
  const capped = cap < normal ? cap : normal;
  return capped < today ? today : capped;
}

/**
 * R-820 — expiry of an extension quote (Extend term): the same 30 days from today, but never
 * past the subscription's current renewal date — the last day the current term covers, after
 * which the renewal flow takes over. It used to be renewal + grace days, so a quote raised
 * just after a yearly renewal stayed open ~339 days (Q-F588-27-0009, local, 10 Oct 2026).
 * Never before today. Quotes already stored keep their expiry.
 */
export function extensionQuoteExpiry(todayISO: string, renewalDate: string): string {
  return addSeatsQuoteExpiry(todayISO, renewalDate);
}
