/**
 * R-2165 (G-ADS-AI, AI-09) — the question → plan reader that needs no AI.
 *
 * Most questions are a handful of words ("last 7 days ROAS", "top ads this month", "spend by
 * platform"). Reading those with fixed rules is free, instant and cannot be talked into
 * anything: the output is only ever a QueryPlan built from the allowlists in plan.ts. When
 * the rules find no number to show (`confident: false`), the AI planner (brain.ts) is asked,
 * and its answer goes through the same zod schema.
 *
 * Two choices made for the person, written into `notes` so the answer says so:
 *   - A question with no split gets a time split (day / week / month by range length), so the
 *     answer always has a chart; the summary still uses the total.
 *   - A ratio brings its parts (ROAS → revenue + spend, CAC → spend + paid orders, CTR →
 *     clicks + impressions, CPC → spend + clicks), so "5.9×" never stands alone.
 */
import {
  addDays, BY_AD_METRICS, SPEND_METRICS, TIME_DIMENSIONS, type NeoDimension, type NeoMetric, type NeoPlatform,
  type NeoRange, type QueryPlan,
} from "./plan";
import { istToday } from "@/lib/dates/ist";

export interface RulesPlan {
  plan: QueryPlan;
  /** True when at least one metric was named — otherwise the AI planner is worth asking. */
  confident: boolean;
  notes: string[];
}

const METRIC_WORDS: Array<[RegExp, NeoMetric]> = [
  [/\broas\b|return on ad|return on spend/, "roas"],
  [/\bcac\b|cost per (customer|acquisition|order|sale)/, "cac"],
  [/\bctr\b|click[- ]?through/, "ctr"],
  [/\bcpc\b|cost per click/, "cpc"],
  [/\bcpm\b|cost per (thousand|mille|1000)/, "cpm"],
  [/\bspen[dt]\b|\bspending\b|ad cost|\bcosts?\b|\bbudget used\b/, "spend"],
  [/\brevenue\b|\bsales\b|\bearn(ed|ings)?\b|\bincome\b|\bmoney (came|in)\b/, "revenue"],
  [/\b(paid )?orders?\b|\bconversions?\b|\bpurchases?\b|\bcustomers won\b/, "paid_orders"],
  [/\bleads?\b|\benquir(y|ies)\b|\bsign[- ]?ups?\b/, "leads"],
  [/\bclicks?\b/, "clicks"],
  [/\bimpressions?\b|\bviews?\b|\breach\b/, "impressions"],
];

/** A ratio and the numbers it is made of. */
const PARTS: Partial<Record<NeoMetric, NeoMetric[]>> = {
  roas: ["revenue", "spend"],
  cac: ["spend", "paid_orders"],
  ctr: ["clicks", "impressions"],
  cpc: ["spend", "clicks"],
  cpm: ["spend", "impressions"],
};

function readRange(q: string, today: string): NeoRange {
  if (/\btoday\b/.test(q)) return { preset: "today" };
  if (/\byesterday\b/.test(q)) return { preset: "yesterday" };
  if (/\blast month\b|\bprevious month\b/.test(q)) return { preset: "last_month" };
  if (/\bthis month\b|\bmonth to date\b|\bmtd\b/.test(q)) return { preset: "this_month" };
  if (/\b(this|last|past) week\b/.test(q)) return { preset: "last_7_days" };
  const n = q.match(/\b(?:last|past|previous)\s+(\d{1,3})\s+days?\b/);
  if (n) {
    const days = Number(n[1]);
    if (days <= 1) return { preset: "today" };
    if (days === 7) return { preset: "last_7_days" };
    if (days === 14) return { preset: "last_14_days" };
    if (days === 30) return { preset: "last_30_days" };
    if (days === 90) return { preset: "last_90_days" };
    return { from: addDays(today, -(Math.min(days, 366) - 1)), to: today };
  }
  if (/\blast (3|three) months\b|\bquarter\b/.test(q)) return { preset: "last_90_days" };
  return { preset: "last_30_days" };
}

function rangeDays(r: NeoRange, today: string): number {
  if ("from" in r) return Math.round((Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 86_400_000) + 1;
  return { today: 1, yesterday: 1, last_7_days: 7, last_14_days: 14, last_30_days: 30, last_90_days: 90,
    this_month: Number(today.slice(8, 10)), last_month: 31 }[r.preset];
}

/** `today` = the IST date (YYYY-MM-DD); passed in by tests. */
export function planFromRules(question: string, today: string = istToday()): RulesPlan {
  const q = ` ${question.toLowerCase().replace(/[^a-z0-9%\s-]/g, " ").replace(/\s+/g, " ")} `;
  const notes: string[] = [];

  // ── numbers ───────────────────────────────────────────────────────────────
  const named: NeoMetric[] = [];
  for (const [re, m] of METRIC_WORDS) if (re.test(q) && !named.includes(m)) named.push(m);
  const confident = named.length > 0;
  const wantsAds = /\b(top|best|worst|which)\s+(\d+\s+)?ads?\b|\bby ads?\b|\bper ads?\b|\beach ad\b|\bads? (performance|wise)\b/.test(q);
  if (!confident && wantsAds) named.push("revenue", "paid_orders");
  if (!named.length) named.push("spend", "leads", "revenue", "roas");

  // ── splits ────────────────────────────────────────────────────────────────
  const dims: NeoDimension[] = [];
  if (/\bcampaigns?\b/.test(q) && /\b(top|best|worst|which|by|per|each|compare|wise)\b/.test(q)) dims.push("campaign");
  if (wantsAds) dims.push("ad");
  let platform: NeoPlatform | null = null;
  const google = /\bgoogle\b|\badwords\b/.test(q);
  const meta = /\bmeta\b|\bfacebook\b|\binstagram\b|\bfb\b|\binsta\b/.test(q);
  const linkedin = /\blinkedin\b/.test(q);
  if (/\b(by|per|each) (ad )?platforms?\b|\bplatform wise\b|\bplatforms?\b.*\bcompare|\bvs\b|\bversus\b/.test(q) && (google || meta || /\bplatforms?\b/.test(q))) {
    dims.push("platform");
  } else if ([google, meta, linkedin].filter(Boolean).length === 1) {
    platform = google ? "google-ads" : meta ? "meta-ads" : "linkedin-ads";
  }
  if (/\bdaily\b|\bby day\b|\bper day\b|\beach day\b|\bday wise\b|\btrend\b/.test(q)) dims.push("day");
  else if (/\bweekly\b|\bby week\b|\bper week\b|\bweek wise\b/.test(q)) dims.push("week");
  else if (/\bmonthly\b|\bby month\b|\bper month\b|\bmonth wise\b/.test(q)) dims.push("month");

  let metrics: NeoMetric[] = [...named];

  // "ad" goes only with leads / paid orders / revenue — spend is per campaign.
  if (dims.includes("ad") && !metrics.every((m) => BY_AD_METRICS.includes(m))) {
    const kept = metrics.filter((m) => BY_AD_METRICS.includes(m));
    if (kept.length) {
      metrics = kept;
      notes.push("Spend is known per campaign, not per ad — per ad this shows leads, paid orders and revenue.");
    } else {
      dims.splice(dims.indexOf("ad"), 1, "campaign");
      notes.push("Spend is known per campaign, not per ad — showing it per campaign.");
    }
  }
  // "platform" goes only with the platforms' own numbers.
  if ((platform || dims.includes("platform")) && !metrics.every((m) => SPEND_METRICS.includes(m))) {
    const kept = metrics.filter((m) => SPEND_METRICS.includes(m));
    if (kept.length) {
      metrics = kept;
      notes.push("Revenue cannot be split by ad platform yet — per platform this shows the platforms' own numbers.");
    } else {
      if (platform) notes.push(`Revenue cannot be split by ad platform yet — showing all campaigns, not only ${platform === "google-ads" ? "Google" : platform === "meta-ads" ? "Meta" : "LinkedIn"}.`);
      else notes.push("Revenue cannot be split by ad platform yet — showing it per campaign.");
      platform = null;
      if (dims.includes("platform")) dims.splice(dims.indexOf("platform"), 1, ...(dims.includes("campaign") ? [] : ["campaign" as NeoDimension]));
    }
  }

  // a ratio brings its parts
  for (const m of [...metrics]) {
    for (const part of PARTS[m] ?? []) {
      const fits = (!dims.includes("ad") || BY_AD_METRICS.includes(part)) && (!(platform || dims.includes("platform")) || SPEND_METRICS.includes(part));
      if (fits && !metrics.includes(part) && metrics.length < 6) metrics.push(part);
    }
  }
  metrics = metrics.slice(0, 6);

  const range = readRange(q, today);

  // ── top N / sort ──────────────────────────────────────────────────────────
  const top = q.match(/\b(?:top|best|worst)\s+(\d{1,3})\b/);
  const ranked = /\b(top|best|worst|highest|lowest|which)\b/.test(q) || dims.includes("ad") || dims.includes("campaign");
  let limit = top ? Math.min(200, Math.max(1, Number(top[1]))) : ranked ? (dims.includes("ad") ? 5 : 10) : 20;

  // no split → a time split so there is a chart
  if (!dims.some((d) => TIME_DIMENSIONS.includes(d)) && dims.length === 0) {
    const days = rangeDays(range, today);
    dims.push(days <= 31 ? "day" : days <= 120 ? "week" : "month");
  }
  if (dims.some((d) => TIME_DIMENSIONS.includes(d)) && dims.length === 1) limit = 200;

  const sorted = dims.some((d) => !TIME_DIMENSIONS.includes(d));
  const plan: QueryPlan = {
    metrics,
    dimensions: dims.slice(0, 2),
    range,
    campaign: null,
    platform,
    sort: sorted ? { metric: metrics[0], direction: /\b(worst|lowest)\b/.test(q) ? "asc" : "desc" } : null,
    limit,
  };
  return { plan, confident: confident || wantsAds, notes };
}
