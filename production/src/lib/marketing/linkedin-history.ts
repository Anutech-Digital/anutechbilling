/** Date windows for LinkedIn Ads history. Older performance is stored by full month. */
import { addDaysISO, utcDateISO } from "@/lib/dates/ist";

export type LinkedInHistoryChunk = { from: string; to: string; granularity: "DAILY" | "MONTHLY" };

const utc = (day: string) => new Date(`${day}T00:00:00Z`);
const iso = utcDateISO;
const monthStart = (day: string) => `${day.slice(0, 7)}-01`;
const monthEnd = (day: string) => iso(new Date(Date.UTC(utc(day).getUTCFullYear(), utc(day).getUTCMonth() + 1, 0)));

export function isIsoDay(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(utc(day).getTime()) && iso(utc(day)) === day;
}

/** Keep a complete ten-year window; LinkedIn may reject the partial oldest month. */
export function linkedInOldestDay(today: string): string {
  const d = utc(today);
  return iso(new Date(Date.UTC(d.getUTCFullYear() - 10, d.getUTCMonth() + 1, 1)));
}

/** Full months before this day are requested monthly; recent months are daily. */
export function linkedInDailyFrom(today: string): string {
  const d = utc(today);
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 5, 1)));
}

/** Requests stay small enough for LinkedIn and a single HTTP response. */
export function linkedInHistoryChunks(from: string, to: string, today: string): LinkedInHistoryChunk[] {
  if (!isIsoDay(from) || !isIsoDay(to) || !isIsoDay(today)) throw new Error("Choose valid dates.");
  if (from > to || to > today || from < linkedInOldestDay(today)) throw new Error("Choose dates within LinkedIn's available ten-year history.");

  const chunks: LinkedInHistoryChunk[] = [];
  const dailyFrom = linkedInDailyFrom(today);
  if (from < dailyFrom) {
    let cursor = monthStart(from);
    const last = to < dailyFrom ? monthEnd(to) : addDaysISO(dailyFrom, -1);
    while (cursor <= last) {
      const yearEnd = `${cursor.slice(0, 4)}-12-31`;
      const end = yearEnd < last ? yearEnd : last;
      chunks.push({ from: cursor, to: end, granularity: "MONTHLY" });
      cursor = addDaysISO(end, 1);
    }
  }
  if (to >= dailyFrom) {
    let cursor = from > dailyFrom ? from : dailyFrom;
    while (cursor <= to) {
      const end90 = addDaysISO(cursor, 89);
      const end = end90 < to ? end90 : to;
      chunks.push({ from: cursor, to: end, granularity: "DAILY" });
      cursor = addDaysISO(end, 1);
    }
  }
  return chunks;
}
