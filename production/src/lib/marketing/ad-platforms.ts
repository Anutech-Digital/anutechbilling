/**
 * Ad platforms (Google Ads, Meta Ads) — the pure part.
 *
 * What the platforms reported (rows from ad_spend_daily, migration 20260927260000) turned
 * into what the owner wants to know: this month's spend and pace against the budget, each
 * campaign's cost per click / per lead, and whether the platform's number and the books
 * agree. The fetching is lib/google/google-ads-api.ts and lib/meta/meta-ads-api.ts; the
 * payload → row parsers live here so they are tested without an account.
 */

import { addDaysISO } from "@/lib/dates/ist";

export type AdPlatform = "google-ads" | "meta-ads";

export const PLATFORM_LABEL: Record<AdPlatform, string> = { "google-ads": "Google Ads", "meta-ads": "Facebook / Instagram Ads" };

/** The `expenses.channel` / `leads.source` key each platform's spend belongs to. */
export const PLATFORM_CHANNEL: Record<AdPlatform, string> = { "google-ads": "google-ads", "meta-ads": "meta-ads" };

/** Both platforms restate the last ~4 weeks (late conversions, invalid-click credits). */
export const AD_REFRESH_DAYS = 35;
/** First sync: a bit over a year, so last-FY comparisons work from day one. */
export const AD_BACKFILL_DAYS = 400;

/** Google Ads scope. Meta's is the `ads_read` permission on its own OAuth. */
export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";

export interface AdSpendRow {
  platform: AdPlatform;
  account_id: string;          // ad_accounts.id
  day: string;
  campaign_id: string;
  campaign_name: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversion_value: number;
}

function addDays(iso: string, n: number): string {
  return addDaysISO(iso, n);
}
const r2 = (n: number) => Math.round(n * 100) / 100;

// ── Totals ─────────────────────────────────────────────────────────────────

export interface AdTotals {
  spend: number; impressions: number; clicks: number; conversions: number; conversionValue: number;
  ctr: number | null;    // clicks / impressions, %
  cpc: number | null;    // spend / clicks
  cpa: number | null;    // spend / conversions (platform-reported)
}

export function totalsOf(rows: readonly AdSpendRow[]): AdTotals {
  const t = { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 };
  for (const r of rows) { t.spend += r.spend; t.impressions += r.impressions; t.clicks += r.clicks; t.conversions += r.conversions; t.conversionValue += r.conversion_value; }
  return {
    ...t, spend: r2(t.spend), conversions: r2(t.conversions), conversionValue: r2(t.conversionValue),
    ctr: t.impressions ? r2((t.clicks / t.impressions) * 100) : null,
    cpc: t.clicks ? r2(t.spend / t.clicks) : null,
    cpa: t.conversions ? r2(t.spend / t.conversions) : null,
  };
}

export interface CampaignStat extends AdTotals {
  platform: AdPlatform; campaign_id: string; campaign_name: string;
  /** Last day the campaign spent anything in the range. */
  lastActive: string;
  /** App leads attributed to this campaign (utm_campaign match), when known. */
  leads: number;
  cpl: number | null;
}

/** Per-campaign table for a range, biggest spender first. `leadsByCampaign` keys are utm_campaign (case-insensitive). */
export function campaignStats(rows: readonly AdSpendRow[], leadsByCampaign: ReadonlyMap<string, number> = new Map()): CampaignStat[] {
  const groups = new Map<string, AdSpendRow[]>();
  for (const r of rows) { const k = `${r.platform}|${r.campaign_id}`; const a = groups.get(k) ?? []; a.push(r); groups.set(k, a); }
  const norm = (s: string) => s.trim().toLowerCase();
  const leadsIdx = new Map<string, number>();
  for (const [k, v] of leadsByCampaign) leadsIdx.set(norm(k), (leadsIdx.get(norm(k)) ?? 0) + v);
  return [...groups.values()].map((g) => {
    const t = totalsOf(g);
    const name = g[g.length - 1].campaign_name;
    const leads = leadsIdx.get(norm(name)) ?? leadsIdx.get(norm(g[0].campaign_id)) ?? 0;
    return {
      ...t, platform: g[0].platform, campaign_id: g[0].campaign_id, campaign_name: name,
      lastActive: g.reduce((m, r) => (r.day > m ? r.day : m), g[0].day),
      leads, cpl: leads ? r2(t.spend / leads) : null,
    };
  }).sort((a, b) => b.spend - a.spend);
}

// ── Pacing ─────────────────────────────────────────────────────────────────

export interface Pacing {
  month: string;             // YYYY-MM
  spent: number;             // platform spend so far this month
  budget: number | null;     // from marketing_tools.monthly_budget (per platform) — null when not set
  daysGone: number;
  daysInMonth: number;
  dailyRate: number;         // spent / daysGone
  projected: number;         // dailyRate × daysInMonth
  /** Fraction of budget the projection lands at; null without a budget. */
  projectedPct: number | null;
  verdict: "no_budget" | "under" | "on_track" | "over";
}

export function pacing(rows: readonly AdSpendRow[], today: string, budget: number | null): Pacing {
  const month = today.slice(0, 7);
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const daysGone = Number(today.slice(8, 10));
  const spent = r2(rows.filter((r) => r.day.startsWith(month)).reduce((s, r) => s + r.spend, 0));
  const dailyRate = daysGone ? spent / daysGone : 0;
  const projected = r2(dailyRate * daysInMonth);
  const projectedPct = budget && budget > 0 ? Math.round((projected / budget) * 100) : null;
  const verdict: Pacing["verdict"] = projectedPct === null ? "no_budget" : projectedPct > 110 ? "over" : projectedPct < 70 ? "under" : "on_track";
  return { month, spent, budget, daysGone, daysInMonth, dailyRate: r2(dailyRate), projected, projectedPct, verdict };
}

// ── Platform vs books ──────────────────────────────────────────────────────

export interface MonthReconcile {
  month: string;
  platform: number;
  books: number;
  diff: number;              // books − platform
  diffPct: number | null;    // relative to platform
  note: string;
}

/**
 * The platform says what was consumed; the books say what was billed and paid. Google
 * bills monthly in arrears (so the month's expense ≈ platform spend + 18% GST); Meta is
 * prepaid (the top-up is an advance, the month's consumption comes off it). A gap is
 * information, not an error — this names the likely reason.
 */
export function reconcileMonths(platformRows: readonly AdSpendRow[], booksByMonth: ReadonlyMap<string, number>, platform: AdPlatform, gstRate = 0.18): MonthReconcile[] {
  const byMonth = new Map<string, number>();
  for (const r of platformRows) byMonth.set(r.day.slice(0, 7), (byMonth.get(r.day.slice(0, 7)) ?? 0) + r.spend);
  const months = new Set([...byMonth.keys(), ...booksByMonth.keys()]);
  return [...months].sort().reverse().map((month) => {
    const p = r2(byMonth.get(month) ?? 0), b = r2(booksByMonth.get(month) ?? 0);
    const diff = r2(b - p);
    const diffPct = p > 0 ? Math.round((diff / p) * 100) : null;
    let note: string;
    if (p === 0 && b === 0) note = "—";
    else if (b === 0) note = platform === "meta-ads" ? "Nothing in books — consume from the advance to create the expense (Prepaid page)" : "Nothing in books — add an expense (channel Google Ads) when Google's invoice arrives";
    else if (p === 0) note = "Platform reported nothing this month — was the account connected?";
    else if (Math.abs(diff - r2(p * gstRate)) <= Math.max(50, p * 0.02)) note = `Difference ≈ ${Math.round(gstRate * 100)}% GST — matches`;
    else if (Math.abs(diff) <= Math.max(50, p * 0.02)) note = "Matches";
    else if (diff > 0) note = "Books higher — a full top-up / advance was probably expensed; actual consumption is lower";
    else note = "Books lower — invoice not booked yet, or booked on the wrong channel";
    return { month, platform: p, books: b, diff, diffPct, note };
  });
}

// ── Series ─────────────────────────────────────────────────────────────────

export interface DayPoint { day: string; google: number; meta: number; clicks: number; conversions: number }

export function dailySeries(rows: readonly AdSpendRow[], from: string, to: string): DayPoint[] {
  const idx = new Map<string, DayPoint>();
  for (let d = from; d <= to; d = addDays(d, 1)) idx.set(d, { day: d, google: 0, meta: 0, clicks: 0, conversions: 0 });
  for (const r of rows) {
    const p = idx.get(r.day); if (!p) continue;
    if (r.platform === "google-ads") p.google = r2(p.google + r.spend); else p.meta = r2(p.meta + r.spend);
    p.clicks += r.clicks; p.conversions = r2(p.conversions + r.conversions);
  }
  return [...idx.values()];
}

// ── Google Ads payloads ────────────────────────────────────────────────────

/** GAQL for daily campaign spend. Dates inclusive. */
export function gaqlCampaignSpend(from: string, to: string): string {
  return `SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${from}' AND '${to}' AND metrics.cost_micros > 0`;
}

export interface GoogleSearchStreamChunk {
  results?: {
    campaign?: { id?: string | number; name?: string };
    segments?: { date?: string };
    metrics?: { costMicros?: string | number; impressions?: string | number; clicks?: string | number; conversions?: string | number; conversionsValue?: string | number };
  }[];
}

export function googleRowsFromSearchStream(chunks: readonly GoogleSearchStreamChunk[], accountId: string): AdSpendRow[] {
  const out: AdSpendRow[] = [];
  for (const c of chunks) for (const r of c.results ?? []) {
    const id = r.campaign?.id, day = r.segments?.date;
    if (id === undefined || !day) continue;
    out.push({
      platform: "google-ads", account_id: accountId, day, campaign_id: String(id), campaign_name: r.campaign?.name ?? String(id),
      spend: r2(Number(r.metrics?.costMicros ?? 0) / 1_000_000),
      impressions: Math.round(Number(r.metrics?.impressions ?? 0)), clicks: Math.round(Number(r.metrics?.clicks ?? 0)),
      conversions: r2(Number(r.metrics?.conversions ?? 0)), conversion_value: r2(Number(r.metrics?.conversionsValue ?? 0)),
    });
  }
  return out;
}

// ── Meta payloads ──────────────────────────────────────────────────────────

/** Meta reports dozens of action types; these are the ones that mean "a lead happened". */
export const META_LEAD_ACTIONS = new Set([
  "lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead", "leadgen_grouped",
  "onsite_conversion.messaging_conversation_started_7d", "onsite_conversion.messaging_first_reply",
  "contact", "submit_application", "schedule",
]);

export interface MetaInsightRow {
  campaign_id?: string; campaign_name?: string; date_start?: string; spend?: string | number;
  impressions?: string | number; clicks?: string | number;
  actions?: { action_type?: string; value?: string | number }[];
  action_values?: { action_type?: string; value?: string | number }[];
}

export function metaRowsFromInsights(data: readonly MetaInsightRow[], accountId: string): AdSpendRow[] {
  return data.flatMap((r) => {
    if (!r.campaign_id || !r.date_start) return [];
    const conv = (r.actions ?? []).filter((a) => a.action_type && META_LEAD_ACTIONS.has(a.action_type)).reduce((s, a) => s + Number(a.value ?? 0), 0);
    const val = (r.action_values ?? []).filter((a) => a.action_type && META_LEAD_ACTIONS.has(a.action_type)).reduce((s, a) => s + Number(a.value ?? 0), 0);
    return [{
      platform: "meta-ads" as const, account_id: accountId, day: r.date_start, campaign_id: r.campaign_id, campaign_name: r.campaign_name ?? r.campaign_id,
      spend: r2(Number(r.spend ?? 0)), impressions: Math.round(Number(r.impressions ?? 0)), clicks: Math.round(Number(r.clicks ?? 0)),
      conversions: r2(conv), conversion_value: r2(val),
    }];
  });
}

// ── CSV ────────────────────────────────────────────────────────────────────

export const AD_CSV_HEADERS = ["Day", "Platform", "Campaign", "Spend", "Impressions", "Clicks", "Conversions", "Conversion value"];
export function adCsvRows(rows: readonly AdSpendRow[]): (string | number)[][] {
  return [...rows].sort((a, b) => a.day.localeCompare(b.day) || a.platform.localeCompare(b.platform))
    .map((r) => [r.day, PLATFORM_LABEL[r.platform], r.campaign_name, r.spend, r.impressions, r.clicks, r.conversions, r.conversion_value]);
}
