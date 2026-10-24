/**
 * R-1716 — "Invoice to raise" age on /invoices, in IST calendar days, never negative.
 *
 * The panel did `Math.floor((Date.now() - new Date(anchor)) / 86400000)`. A date-only anchor
 * ("2026-10-21") parses as UTC midnight = 05:30 IST, so between 00:00 and 05:30 IST on that
 * same day the difference was negative and the row read "-1d".
 */
import { daysBetweenISO, istToday, toIstDate } from "@/lib/dates/ist";

/** Whole IST days from `anchor` (date or timestamp) to `today` (YYYY-MM-DD). 0 when unknown. */
export function toInvoiceAgeDays(anchor: string | null | undefined, today: string = istToday()): number {
  if (!anchor) return 0;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(anchor) ? anchor : toIstDate(anchor);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return 0;
  return Math.max(0, daysBetweenISO(day, today));
}
