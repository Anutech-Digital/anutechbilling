/**
 * R-2165 (G-ADS-AI, AI-09) — Neo's typed query plan.
 *
 * Neo never writes SQL. A question becomes THIS plan (metrics, dimensions, date range,
 * filters), the plan is checked here with zod (strict: no extra fields), and only then is it
 * handed — as plain parameters — to the database function public.marketing_metrics_query
 * (migration 20261030104756), which checks the same allowlists again.
 *
 * The lists below are the SQL function's lists. tests/… parity: plan.test.ts reads the
 * migration and fails when the two drift.
 */
import { z } from "zod";
import { istToday, utcDateISO } from "@/lib/dates/ist";

/** Who may ask Neo: the marketing agent's people (AGENT_ROLES, R-2157); the SQL function checks the same two. */
export const NEO_ROLES: readonly string[] = ["owner", "marketing"];

export const NEO_METRICS = [
  "spend", "clicks", "impressions", "ctr", "cpc", "cpm", "leads", "paid_orders", "revenue", "roas", "cac",
] as const;
export type NeoMetric = (typeof NEO_METRICS)[number];

export const NEO_DIMENSIONS = ["day", "week", "month", "campaign", "platform", "ad"] as const;
export type NeoDimension = (typeof NEO_DIMENSIONS)[number];

export const NEO_PLATFORMS = ["google-ads", "meta-ads", "linkedin-ads"] as const;
export type NeoPlatform = (typeof NEO_PLATFORMS)[number];

/** Metrics the ad platforms report per campaign per day — the only ones "platform" goes with. */
export const SPEND_METRICS: readonly NeoMetric[] = ["spend", "clicks", "impressions", "ctr", "cpc", "cpm"];
/** Metrics known per ad (from the lead / order's utm_content) — the only ones "ad" goes with. */
export const BY_AD_METRICS: readonly NeoMetric[] = ["leads", "paid_orders", "revenue"];
/** Metrics built from payments (hidden for a role that cannot see payments). */
export const MONEY_METRICS: readonly NeoMetric[] = ["paid_orders", "revenue", "roas", "cac"];
export const TIME_DIMENSIONS: readonly NeoDimension[] = ["day", "week", "month"];

export const NEO_RANGE_PRESETS = [
  "today", "yesterday", "last_7_days", "last_14_days", "last_30_days", "last_90_days", "this_month", "last_month",
] as const;
export type NeoRangePreset = (typeof NEO_RANGE_PRESETS)[number];

export const MAX_RANGE_DAYS = 366;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const RangeSchema = z.union([
  z.object({ preset: z.enum(NEO_RANGE_PRESETS) }).strict(),
  z.object({
    /** First day, YYYY-MM-DD. */
    from: z.string().regex(ISO_DAY, "Dates are YYYY-MM-DD."),
    /** Last day INCLUDED, YYYY-MM-DD (the SQL end is the day after). */
    to: z.string().regex(ISO_DAY, "Dates are YYYY-MM-DD."),
  }).strict(),
]);
export type NeoRange = z.infer<typeof RangeSchema>;

export const QueryPlanSchema = z.object({
  metrics: z.array(z.enum(NEO_METRICS)).min(1, "Ask for at least one number.").max(6, "Ask for at most 6 numbers at once."),
  dimensions: z.array(z.enum(NEO_DIMENSIONS)).max(2, "Split by at most two things.").default([]),
  range: RangeSchema,
  campaign: z.string().trim().min(1).max(80).nullish(),
  platform: z.enum(NEO_PLATFORMS).nullish(),
  sort: z.object({ metric: z.enum(NEO_METRICS), direction: z.enum(["desc", "asc"]) }).strict().nullish(),
  limit: z.number().int().min(1).max(200).default(20),
}).strict().superRefine((p, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (new Set(p.metrics).size !== p.metrics.length) issue("A number is listed twice.");
  if (new Set(p.dimensions).size !== p.dimensions.length) issue("A split is listed twice.");
  if (p.dimensions.filter((d) => TIME_DIMENSIONS.includes(d)).length > 1) issue("Use only one of day, week or month.");
  if ((p.platform || p.dimensions.includes("platform")) && !p.metrics.every((m) => SPEND_METRICS.includes(m))) {
    issue("Per platform there are only spend, clicks, impressions, CTR, CPC and CPM.");
  }
  if (p.dimensions.includes("ad") && !p.metrics.every((m) => BY_AD_METRICS.includes(m))) {
    issue("Per ad there are only leads, paid orders and revenue — spend is known per campaign.");
  }
  if (p.sort && !p.metrics.includes(p.sort.metric)) issue("Sort by one of the numbers asked for.");
});
export type QueryPlan = z.infer<typeof QueryPlanSchema>;

/** [from, to) for the SQL function plus a label for people. */
export interface ResolvedRange { from: string; to: string; label: string; days: number }

/** YYYY-MM-DD plus n calendar days. */
export const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return utcDateISO(d);
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function shortDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** The plan's range in IST calendar days (today = the IST date). */
export function resolveNeoRange(range: NeoRange, today: string = istToday()): ResolvedRange {
  const span = (from: string, toIncl: string, name: string): ResolvedRange => {
    const to = addDays(toIncl, 1);
    const days = daysBetween(from, to);
    const dates = from === toIncl ? shortDay(from) : `${shortDay(from)} – ${shortDay(toIncl)}`;
    return { from, to, days, label: name ? `${name} (${dates})` : dates };
  };
  if ("preset" in range) {
    const month1 = `${today.slice(0, 7)}-01`;
    switch (range.preset) {
      case "today": return span(today, today, "Today");
      case "yesterday": { const y = addDays(today, -1); return span(y, y, "Yesterday"); }
      case "last_7_days": return span(addDays(today, -6), today, "Last 7 days");
      case "last_14_days": return span(addDays(today, -13), today, "Last 14 days");
      case "last_30_days": return span(addDays(today, -29), today, "Last 30 days");
      case "last_90_days": return span(addDays(today, -89), today, "Last 90 days");
      case "this_month": return span(month1, today, "This month");
      case "last_month": {
        const lastDay = addDays(month1, -1);
        return span(`${lastDay.slice(0, 7)}-01`, lastDay, "Last month");
      }
    }
  }
  return span(range.from, range.to, "");
}

/** A range the SQL function will accept, or the reason it will not. */
export function rangeProblem(r: ResolvedRange): string | null {
  if (!ISO_DAY.test(r.from) || !ISO_DAY.test(r.to) || Number.isNaN(r.days)) return "Use real dates (YYYY-MM-DD).";
  if (r.days < 1) return "The end date is before the start date.";
  if (r.days > MAX_RANGE_DAYS) return "Ask about at most one year at a time.";
  return null;
}

/** Exactly the parameters of public.marketing_metrics_query, in order. */
export interface MetricsRpcArgs {
  metrics: NeoMetric[];
  dimensions: NeoDimension[];
  from: string;
  to: string;
  campaign: string | null;
  platform: NeoPlatform | null;
  sort: NeoMetric | null;
  sortDesc: boolean;
  limit: number;
}

export function rpcArgs(plan: QueryPlan, range: ResolvedRange): MetricsRpcArgs {
  return {
    metrics: [...plan.metrics],
    dimensions: [...plan.dimensions],
    from: range.from,
    to: range.to,
    campaign: plan.campaign ?? null,
    platform: plan.platform ?? null,
    sort: plan.sort?.metric ?? null,
    sortDesc: (plan.sort?.direction ?? "desc") === "desc",
    limit: plan.limit,
  };
}

/** What the database function returns (jsonb). */
export interface MetricsResult {
  metrics: NeoMetric[];
  dimensions: NeoDimension[];
  from: string;
  to: string;
  revenue_visible: boolean;
  rows: Array<Record<string, string | number | null>>;
  total: Partial<Record<NeoMetric, number | null>>;
  row_count: number;
  truncated: boolean;
}

export const METRIC_LABEL: Record<NeoMetric, string> = {
  spend: "Spend", clicks: "Clicks", impressions: "Impressions", ctr: "CTR", cpc: "CPC", cpm: "CPM",
  leads: "Leads", paid_orders: "Paid orders", revenue: "Revenue", roas: "ROAS", cac: "CAC",
};

export const DIMENSION_LABEL: Record<NeoDimension, string> = {
  day: "Day", week: "Week", month: "Month", campaign: "Campaign", platform: "Platform", ad: "Ad",
};
