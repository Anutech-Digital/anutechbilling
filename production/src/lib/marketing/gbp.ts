/**
 * Google Business Profile — the pure part.
 *
 * What the listing did (impressions on Maps / Search, calls, directions, website clicks),
 * what people said (reviews), and what the owner should do about it — computed from rows
 * the sync wrote (migration 20260927250000). Nothing here touches the network or the DB;
 * lib/google/gbp-api.ts does the fetching and this file does the arithmetic, so the numbers
 * on the page are testable without a Google account.
 */

/** OAuth scope for every Business Profile API (accounts, locations, reviews, performance). */
import { addDaysISO } from "@/lib/dates/ist";

export const GBP_SCOPE = "https://www.googleapis.com/auth/business.manage";

/** Performance API daily metrics we fetch, in the order the page shows them. */
export const GBP_METRICS = [
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
  "CALL_CLICKS",
  "WEBSITE_CLICKS",
  "BUSINESS_DIRECTION_REQUESTS",
  "BUSINESS_CONVERSATIONS",
  "BUSINESS_BOOKINGS",
] as const;
export type GbpMetric = (typeof GBP_METRICS)[number];

/**
 * Google publishes performance data with a lag of a few days; asking for yesterday returns
 * zeros that later become real numbers. The sync therefore ends its window 3 days back and
 * always re-fetches the last 30 days, so late corrections overwrite what was stored.
 */
export const GBP_METRIC_LAG_DAYS = 3;
export const GBP_METRIC_REFRESH_DAYS = 30;
/** First sync pulls the whole window Google keeps. */
export const GBP_METRIC_BACKFILL_DAYS = 540;

export const STAR_RATINGS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
export function starToNumber(s: string | null | undefined): number | null {
  if (!s) return null;
  return STAR_RATINGS[s.toUpperCase()] ?? null;
}

export interface MetricRow { day: string; metric: string; value: number }

export interface MetricTotals {
  impressions: number;
  maps: number;
  search: number;
  mobile: number;
  desktop: number;
  calls: number;
  website: number;
  directions: number;
  messages: number;
  bookings: number;
  /** calls + website + directions + messages + bookings — the listing made someone do something. */
  actions: number;
  /** actions / impressions, as a percentage (0 when no impressions). */
  actionRate: number;
}

const IMPRESSION_METRICS = new Set<string>([
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
]);

export function totalsOf(rows: readonly MetricRow[]): MetricTotals {
  const t: MetricTotals = { impressions: 0, maps: 0, search: 0, mobile: 0, desktop: 0, calls: 0, website: 0, directions: 0, messages: 0, bookings: 0, actions: 0, actionRate: 0 };
  for (const r of rows) {
    const v = Math.max(0, Math.round(r.value));
    if (IMPRESSION_METRICS.has(r.metric)) {
      t.impressions += v;
      if (r.metric.endsWith("_MAPS")) t.maps += v; else t.search += v;
      if (r.metric.includes("_MOBILE_")) t.mobile += v; else t.desktop += v;
    } else if (r.metric === "CALL_CLICKS") t.calls += v;
    else if (r.metric === "WEBSITE_CLICKS") t.website += v;
    else if (r.metric === "BUSINESS_DIRECTION_REQUESTS") t.directions += v;
    else if (r.metric === "BUSINESS_CONVERSATIONS") t.messages += v;
    else if (r.metric === "BUSINESS_BOOKINGS") t.bookings += v;
  }
  t.actions = t.calls + t.website + t.directions + t.messages + t.bookings;
  t.actionRate = t.impressions ? Math.round((t.actions / t.impressions) * 1000) / 10 : 0;
  return t;
}

export interface PeriodComparison {
  current: MetricTotals;
  previous: MetricTotals;
  /** Percentage change per headline number; null when the previous period was zero. */
  change: { impressions: number | null; actions: number | null; calls: number | null; website: number | null; directions: number | null };
  from: string;
  to: string;
}

function addDays(iso: string, n: number): string {
  return addDaysISO(iso, n);
}
function pct(cur: number, prev: number): number | null {
  if (prev <= 0) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

/**
 * The last `days` days that Google has data for, against the `days` before them.
 * `today` is the calendar date; the window ends GBP_METRIC_LAG_DAYS earlier because
 * the newer days are not published yet and would drag the average down.
 */
export function comparePeriods(rows: readonly MetricRow[], today: string, days = 28): PeriodComparison {
  const to = addDays(today, -GBP_METRIC_LAG_DAYS);
  const from = addDays(to, -(days - 1));
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  const current = totalsOf(rows.filter((r) => r.day >= from && r.day <= to));
  const previous = totalsOf(rows.filter((r) => r.day >= prevFrom && r.day <= prevTo));
  return {
    current, previous, from, to,
    change: {
      impressions: pct(current.impressions, previous.impressions),
      actions: pct(current.actions, previous.actions),
      calls: pct(current.calls, previous.calls),
      website: pct(current.website, previous.website),
      directions: pct(current.directions, previous.directions),
    },
  };
}

export interface DayPoint { day: string; impressions: number; actions: number; calls: number; website: number; directions: number }

/** One point per day for the chart; days with no rows are shown as zero, not skipped. */
export function dailySeries(rows: readonly MetricRow[], from: string, to: string): DayPoint[] {
  const byDay = new Map<string, MetricRow[]>();
  for (const r of rows) { if (r.day >= from && r.day <= to) { const a = byDay.get(r.day) ?? []; a.push(r); byDay.set(r.day, a); } }
  const out: DayPoint[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const t = totalsOf(byDay.get(d) ?? []);
    out.push({ day: d, impressions: t.impressions, actions: t.actions, calls: t.calls, website: t.website, directions: t.directions });
  }
  return out;
}

/** Weekly buckets (Mon–Sun) for long ranges, so a 90-day chart is not 90 spiky bars. */
export function weeklySeries(points: readonly DayPoint[]): DayPoint[] {
  const weeks = new Map<string, DayPoint>();
  for (const p of points) {
    const d = new Date(`${p.day}T00:00:00Z`);
    const dow = (d.getUTCDay() + 6) % 7;             // Monday = 0
    const monday = addDays(p.day, -dow);
    const w = weeks.get(monday) ?? { day: monday, impressions: 0, actions: 0, calls: 0, website: 0, directions: 0 };
    w.impressions += p.impressions; w.actions += p.actions; w.calls += p.calls; w.website += p.website; w.directions += p.directions;
    weeks.set(monday, w);
  }
  return [...weeks.values()].sort((a, b) => a.day.localeCompare(b.day));
}

// ── Reviews ────────────────────────────────────────────────────────────────

export interface ReviewLike {
  star_rating: number;
  comment: string | null;
  reply_comment: string | null;
  reviewed_at: string;
  reviewer_name?: string | null;
}

export interface ReviewStats {
  count: number;
  average: number | null;
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
  unanswered: number;
  /** Unanswered reviews older than 3 days — Google's own guidance is to reply within a few days. */
  overdue: number;
  last30: number;
  last30Average: number | null;
  /** Fraction of reviews with a reply, as a percentage. */
  replyRate: number;
}

export const REPLY_SLA_DAYS = 3;

export function reviewStats(reviews: readonly ReviewLike[], today: string): ReviewStats {
  const distribution: ReviewStats["distribution"] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0, unanswered = 0, overdue = 0, last30 = 0, last30Sum = 0;
  const cutoff30 = addDays(today, -30);
  const overdueBefore = new Date(`${addDays(today, -REPLY_SLA_DAYS)}T23:59:59Z`).getTime();
  for (const r of reviews) {
    const s = Math.min(5, Math.max(1, Math.round(r.star_rating))) as 1 | 2 | 3 | 4 | 5;
    distribution[s]++;
    sum += s;
    if (!r.reply_comment) {
      unanswered++;
      if (Date.parse(r.reviewed_at) < overdueBefore) overdue++;
    }
    if (r.reviewed_at.slice(0, 10) >= cutoff30) { last30++; last30Sum += s; }
  }
  const n = reviews.length;
  return {
    count: n,
    average: n ? Math.round((sum / n) * 10) / 10 : null,
    distribution, unanswered, overdue, last30,
    last30Average: last30 ? Math.round((last30Sum / last30) * 10) / 10 : null,
    replyRate: n ? Math.round(((n - unanswered) / n) * 100) : 0,
  };
}

/**
 * Drafts a reply in the owner's voice so a 1-tap "Reply" is possible. Deliberately short
 * and honest: thank, name the person, and for a poor rating invite the conversation offline
 * instead of arguing in public — that is what a future customer reading it wants to see.
 */
export function draftReply(r: ReviewLike, companyName: string, ownerPhone?: string | null): string {
  const who = r.reviewer_name && r.reviewer_name.trim() && !/^a google user$/i.test(r.reviewer_name) ? r.reviewer_name.trim().split(/\s+/)[0] : "";
  const hi = who ? `Thank you, ${who}` : "Thank you";
  if (r.star_rating >= 4) {
    return `${hi}, for taking the time to review ${companyName}. It means a lot to our team — we look forward to working with you again.`;
  }
  if (r.star_rating === 3) {
    return `${hi} for the honest feedback. We would like to understand what we could have done better${ownerPhone ? ` — please reach us at ${ownerPhone}` : ""}. — ${companyName}`;
  }
  return `${hi} for telling us. This is not the experience we want anyone to have with ${companyName}. Please contact us directly${ownerPhone ? ` at ${ownerPhone}` : ""} so we can put it right.`;
}

// ── Insights ───────────────────────────────────────────────────────────────

export interface Insight { kind: "good" | "warn" | "act"; text: string; href?: string }

/** Plain-language observations the page shows above the numbers. Ordered by urgency. */
export function insights(cmp: PeriodComparison, stats: ReviewStats, opts: { hasWebsite: boolean; hasPhone: boolean; reviewLinkSaved: boolean }): Insight[] {
  const out: Insight[] = [];
  if (stats.overdue > 0) out.push({ kind: "act", text: `${stats.overdue} review${stats.overdue > 1 ? "s" : ""} unanswered for ${REPLY_SLA_DAYS}+ days — Google and customers both notice whether the owner replies.` });
  if (stats.count && stats.distribution[1] + stats.distribution[2] > 0 && stats.average !== null && stats.average < 4) {
    out.push({ kind: "warn", text: `Average ${stats.average}★ — below 4★ pushes the listing down in "near me" results. Ask happy customers for reviews.`, href: "/marketing/reviews" });
  }
  if (!opts.hasPhone) out.push({ kind: "act", text: "No phone number on the listing — without a \"Call\" button, mobile searchers move on to the next result." });
  if (!opts.hasWebsite) out.push({ kind: "act", text: "No website link on the listing — build a UTM link in Tracking links and add it to the Google profile.", href: "/marketing/links" });
  if (!opts.reviewLinkSaved) out.push({ kind: "act", text: "Google review link is not saved on the Reviews page — sync found it; save it in one click.", href: "/marketing/reviews" });
  if (cmp.change.impressions !== null && cmp.change.impressions <= -20) out.push({ kind: "warn", text: `Listing views fell ${Math.abs(cmp.change.impressions)}% in the last ${daysBetween(cmp.from, cmp.to)} days — check photos / posts / category.` });
  if (cmp.change.actions !== null && cmp.change.actions >= 20) out.push({ kind: "good", text: `Calls + website + directions up ${cmp.change.actions}% — the listing is working.` });
  if (cmp.current.impressions > 0 && cmp.current.actionRate < 2) out.push({ kind: "warn", text: `${cmp.current.impressions.toLocaleString("en-IN")} views, but only ${cmp.current.actionRate}% took an action — review the description, photos and offers.` });
  if (stats.last30 === 0 && stats.count > 0) out.push({ kind: "warn", text: "No new review in the last 30 days — recent reviews count more for ranking.", href: "/marketing/reviews" });
  if (out.length === 0) out.push({ kind: "good", text: "All good — reviews are answered and listing views are stable." });
  return out;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

// ── Google API payload → rows ──────────────────────────────────────────────

/** Shape of `fetchMultiDailyMetricsTimeSeries` (Business Profile Performance API v1). */
export interface PerformancePayload {
  multiDailyMetricTimeSeries?: {
    dailyMetricTimeSeries?: {
      dailyMetric?: string;
      timeSeries?: { datedValues?: { date?: { year?: number; month?: number; day?: number }; value?: string | number }[] };
    }[];
  }[];
}

/** Flattens the nested payload into (day, metric, value) rows; days without a value are 0. */
export function metricRowsFromPayload(p: PerformancePayload): MetricRow[] {
  const out: MetricRow[] = [];
  for (const m of p.multiDailyMetricTimeSeries ?? []) {
    for (const s of m.dailyMetricTimeSeries ?? []) {
      const metric = s.dailyMetric;
      if (!metric) continue;
      for (const dv of s.timeSeries?.datedValues ?? []) {
        const d = dv.date;
        if (!d?.year || !d.month || !d.day) continue;
        const day = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
        out.push({ day, metric, value: Math.max(0, Math.round(Number(dv.value ?? 0)) || 0) });
      }
    }
  }
  return out;
}

export const METRIC_LABEL: Record<GbpMetric, string> = {
  BUSINESS_IMPRESSIONS_DESKTOP_MAPS: "Maps · desktop",
  BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: "Search · desktop",
  BUSINESS_IMPRESSIONS_MOBILE_MAPS: "Maps · mobile",
  BUSINESS_IMPRESSIONS_MOBILE_SEARCH: "Search · mobile",
  CALL_CLICKS: "Calls",
  WEBSITE_CLICKS: "Website clicks",
  BUSINESS_DIRECTION_REQUESTS: "Directions",
  BUSINESS_CONVERSATIONS: "Messages",
  BUSINESS_BOOKINGS: "Bookings",
};

export const GBP_CSV_HEADERS = ["Day", "Impressions", "Maps", "Search", "Calls", "Website clicks", "Directions", "Messages", "Bookings"];
export function metricsCsvRows(rows: readonly MetricRow[]): (string | number)[][] {
  const days = [...new Set(rows.map((r) => r.day))].sort();
  return days.map((d) => { const t = totalsOf(rows.filter((r) => r.day === d)); return [d, t.impressions, t.maps, t.search, t.calls, t.website, t.directions, t.messages, t.bookings]; });
}
