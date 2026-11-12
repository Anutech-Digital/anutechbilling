import { addDaysISO, utcDateISO } from "@/lib/dates/ist";
import type { AdPlatform } from "@/lib/marketing/ad-platforms";
import { isIsoDay, linkedInHistoryChunks, linkedInOldestDay } from "@/lib/marketing/linkedin-history";

export type AdSyncChunk = { platform: AdPlatform; from: string; to: string; granularity: "DAILY" | "MONTHLY" };

/** Keep Meta requests safely inside its shorter Insights lookback period. */
export function metaOldestDay(today: string): string {
  const day = new Date(`${today}T00:00:00Z`);
  const year = day.getUTCFullYear();
  const month = day.getUTCMonth() - 36;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return utcDateISO(new Date(Date.UTC(year, month, Math.min(day.getUTCDate(), lastDay))));
}

/** Keep each request small enough for the ad APIs and the sync route. */
export function adSyncChunks(platform: AdPlatform, from: string, to: string, today: string): AdSyncChunk[] {
  if (platform === "linkedin-ads") return linkedInHistoryChunks(from, to, today).map((chunk) => ({ platform, ...chunk }));
  if (!isIsoDay(from) || !isIsoDay(to) || !isIsoDay(today) || from > to || to > today || from < linkedInOldestDay(today)) {
    throw new Error("Choose dates within the available ten-year history.");
  }
  const startDay = platform === "meta-ads" && from < metaOldestDay(today) ? metaOldestDay(today) : from;
  if (startDay > to) throw new Error("Meta Ads can sync only recent history. Choose a newer date range.");
  const chunks: AdSyncChunk[] = [];
  for (let start = startDay; start <= to;) {
    const end90 = addDaysISO(start, 89);
    const end = end90 < to ? end90 : to;
    chunks.push({ platform, from: start, to: end, granularity: "DAILY" });
    start = addDaysISO(end, 1);
  }
  return chunks;
}
