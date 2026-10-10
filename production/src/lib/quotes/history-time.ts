/**
 * R-815 — the time shown on a quote's "Workflow history" rows.
 *
 * Staging (10 Oct): "Quote created 10 Oct 2026 · 05:30 am" for a quote made at 14:47 IST.
 * The row used `created_date` (a Postgres `date`), which `new Date()` reads as midnight
 * UTC = 05:30 IST. Rules:
 *   - a real timestamp → date + IST time;
 *   - a date-only value → just the date, never a made-up time;
 *   - a timestamp that is exactly 00:00:00.000 UTC or IST is a date that was cast to
 *     `timestamptz` (e.g. a payment's chosen "received on" date) → just the date too.
 *     A real event landing on that exact millisecond is not worth a fake "05:30 am".
 */
import { formatDate } from "@/lib/utils";
import { utcDateISO } from "@/lib/dates/ist";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function historyTime(value: string | null | undefined): string {
  if (!value) return "—";
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return formatDate(v, "short");
  const ms = new Date(v).getTime();
  if (isNaN(ms)) return "—";
  if (ms % DAY_MS === 0) return formatDate(utcDateISO(new Date(ms)), "short");
  if ((ms + IST_OFFSET_MS) % DAY_MS === 0) return formatDate(new Date(ms), "short");
  return formatDate(new Date(ms), "long");
}

/** The best "created" moment: the real `created_at` timestamp, else the `created_date` date. */
export function quoteCreatedAt(q: { created_at?: string | null; created_date?: string | null }): string | null {
  return q.created_at || q.created_date || null;
}
