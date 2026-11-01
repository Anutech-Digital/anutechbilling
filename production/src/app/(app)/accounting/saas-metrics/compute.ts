/**
 * SaaS Metrics figures as a pure function of the subscription rows — R-2229 moved them out of the
 * page so a test can hold the card, the waterfall and the Subscriptions strip to ONE MRR rule.
 */
import { reconstructWaterfall, type MrrWaterfall } from "@/lib/accounting/mrr-waterfall";
import {
  mrrTrend, trendCaveats, retentionCurve, retentionVelocity,
  type MrrPoint, type RetentionPoint, type RetentionVelocity,
} from "@/lib/accounting/saas-charts";
import { toIstDate } from "@/lib/dates/ist";
import { isRecurringSub, recurringMrr, totalMrr } from "@/lib/subscriptions/mrr-of";

export interface SubRow {
  id:              string;
  customer_id:     string | null;
  customer_name:   string | null;
  plan:            string | null;
  vendor:          string | null;        // 'google' | 'microsoft' | 'zoho' | 'other'
  seats:           number | null;
  mrr:             number | null;
  /** R-2229: 0 / missing = no recurring term, so not MRR. Optional so older callers still type. */
  term_months?:    number | null;
  start_date:      string;
  renewal_date:    string | null;
  status:          string;                // 'active' | 'paused' | 'expired' | 'cancelled'
  updated_at:      string;
}

export interface CohortRow {
  monthLabel:    string;     // "May 2026"
  monthKey:      string;     // "2026-05"
  startedCount:  number;     // subs started in that month
  startedMRR:    number;
  retainedCount: number;     // still active today
  retentionPct:  number;
}

export interface MetricsData {
  // Headline
  mrr:              number;
  arr:              number;
  activeCustomers:  number;
  arpc:             number;

  // 30-day movement
  newMRR30d:        number;
  newCustomers30d:  number;
  churnMRR30d:      number;
  churnedCustomers30d: number;
  netMRRChange30d:  number;

  // Derived
  monthlyChurnRate: number;  // % (churn customers / active customers, monthly)
  ltvEstimate:      number;  // ARPC / monthlyChurnRate (capped if churn=0)
  /** Starting → New → Expansion → Contraction → Churn → Ending, with the parts
   *  this schema cannot know left explicitly null. See lib/accounting/mrr-waterfall. */
  waterfall:        MrrWaterfall;

  // Breakdowns
  mrrByVendor:      Array<{ vendor: string; mrr: number; count: number; pct: number }>;
  mrrByTier:        Array<{ tier:   string; mrr: number; count: number; pct: number }>;

  // Cohort retention
  cohorts:          CohortRow[];

  /** Charts. Computed by lib/accounting/saas-charts.ts, never in the component. */
  mrrTrend:         MrrPoint[];
  trendCaveats:     string[];
  retentionCurve:   RetentionPoint[];
  retentionVelocity: RetentionVelocity;
}

/** How far back the trend looks. Twelve months is the reseller's renewal cycle. */
export const TREND_MONTHS = 12;

export function vendorLabel(v: string | null): string {
  if (!v) return "Other";
  return v === "google"    ? "Google Workspace"
       : v === "microsoft" ? "Microsoft 365"
       : v === "zoho"      ? "Zoho"
       :                     v.charAt(0).toUpperCase() + v.slice(1);
}

export function tierFromPlan(plan: string | null): string {
  if (!plan) return "Unknown";
  const p = plan.toLowerCase();
  if (p.includes("starter"))    return "Starter";
  if (p.includes("standard"))   return "Standard";
  if (p.includes("plus"))       return "Plus";
  if (p.includes("enterprise")) return "Enterprise";
  return plan;
}

export function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);                  // "2026-05"
}
export function monthLabel(d: Date): string {
  return d.toLocaleString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
}

export function computeSaasMetrics(all: SubRow[], now: Date = new Date()): MetricsData {
  /* R-2229: MRR is ONE rule (lib/subscriptions/mrr-of): status active AND a recurring line. A
     one-time charge filed as a subscription (e.g. "Email migration (one-time)") or a row with no
     recurring term adds 0. Card, waterfall, vendor/tier split and the Subscriptions strip agree. */
  const active = all.filter((s) => s.status === "active" && isRecurringSub(s));
  /** Not active, so not producing revenue now: cancelled, expired or paused. */
  const stopped = (s: SubRow) => s.status !== "active";

  const mrr = totalMrr(active);
  const arr = mrr * 12;
  const activeCustomers = new Set(active.map((s) => s.customer_id ?? s.id)).size;
  const arpc = activeCustomers > 0 ? Math.round(mrr / activeCustomers) : 0;

  // 30-day window
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgoISO = thirtyDaysAgo.toISOString();
  const thirtyDaysAgoDate = toIstDate(thirtyDaysAgo);

  const newSubs30d   = all.filter((s) => s.start_date >= thirtyDaysAgoDate && isRecurringSub(s));
  /* R-2229: a PAUSED subscription stopped paying too. It is churn here and in the waterfall,
     so the waterfall Ending equals the MRR card (it used to keep paused MRR in Ending). */
  const churnedSubs30d = all.filter((s) => stopped(s) && isRecurringSub(s) && s.updated_at >= thirtyDaysAgoISO);

  // ── MRR waterfall ────────────────────────────────────────────────────
  // Computed by a tested library rather than inline, because this is the
  // figure an owner quotes to a lender or a buyer.
  //
  // `endDate` is `updated_at`, and only for rows that are already dead. That
  // is a PROXY, not a cancellation date: `subscriptions` has no such column
  // (only `suspended_at`, migration 0008), and `updated_at` moves on ANY
  // edit — so a subscription cancelled last year whose row was touched
  // yesterday looks like this month's churn. The caveat is surfaced in the
  // UI instead of being buried here.
  const waterfall = reconstructWaterfall(
    all.map((s) => ({
      id: s.id,
      mrr: recurringMrr(s),
      startDate: s.start_date ?? null,
      endDate: stopped(s) ? (s.updated_at ?? null) : null,
      status: s.status,
    })),
    thirtyDaysAgoISO,
    now.toISOString(),
  );

  const newMRR30d   = newSubs30d.reduce((s, x) => s + recurringMrr(x), 0);
  const churnMRR30d = churnedSubs30d.reduce((s, x) => s + recurringMrr(x), 0);

  // Monthly churn rate — naive: churned customers / active customers, monthly proxy.
  // For a robust SaaS metric, we'd track status transitions over time. Good enough
  // for v1; refine when transition log exists.
  const monthlyChurnRate = activeCustomers > 0
    ? (churnedSubs30d.length / activeCustomers) * 100
    : 0;
  const ltvEstimate = monthlyChurnRate > 0
    ? Math.round(arpc / (monthlyChurnRate / 100))
    : arpc * 36; // floor — assume 3 years if no churn data

  // MRR by vendor
  const vendorMap = new Map<string, { mrr: number; count: number }>();
  for (const s of active) {
    const v = vendorLabel(s.vendor);
    const cur = vendorMap.get(v) ?? { mrr: 0, count: 0 };
    cur.mrr += recurringMrr(s);
    cur.count += 1;
    vendorMap.set(v, cur);
  }
  const mrrByVendor = Array.from(vendorMap.entries())
    .map(([vendor, v]) => ({ vendor, mrr: v.mrr, count: v.count, pct: mrr > 0 ? (v.mrr / mrr) * 100 : 0 }))
    .sort((a, b) => b.mrr - a.mrr);

  // MRR by tier
  const tierMap = new Map<string, { mrr: number; count: number }>();
  for (const s of active) {
    const t = tierFromPlan(s.plan);
    const cur = tierMap.get(t) ?? { mrr: 0, count: 0 };
    cur.mrr += recurringMrr(s);
    cur.count += 1;
    tierMap.set(t, cur);
  }
  const mrrByTier = Array.from(tierMap.entries())
    .map(([tier, v]) => ({ tier, mrr: v.mrr, count: v.count, pct: mrr > 0 ? (v.mrr / mrr) * 100 : 0 }))
    .sort((a, b) => b.mrr - a.mrr);

  // Cohorts — group by start_date month, count retained (status='active' now)
  const cohortMap = new Map<string, { label: string; startedCount: number; startedMRR: number; retainedCount: number }>();
  for (const s of all) {
    const start = new Date(s.start_date + "T00:00:00Z");
    const key = monthKey(start);
    const label = monthLabel(start);
    const cur = cohortMap.get(key) ?? { label, startedCount: 0, startedMRR: 0, retainedCount: 0 };
    cur.startedCount += 1;
    cur.startedMRR   += recurringMrr(s);
    if (s.status === "active") cur.retainedCount += 1;
    cohortMap.set(key, cur);
  }
  const cohorts: CohortRow[] = Array.from(cohortMap.entries())
    .map(([monthKey, c]) => ({
      monthKey,
      monthLabel:    c.label,
      startedCount:  c.startedCount,
      startedMRR:    c.startedMRR,
      retainedCount: c.retainedCount,
      retentionPct:  c.startedCount > 0 ? (c.retainedCount / c.startedCount) * 100 : 0,
    }))
    .sort((a, b) => b.monthKey.localeCompare(a.monthKey));

  /* ── Chart series ──────────────────────────────────────────────────
     Built from `all` and `cohorts`, the same rows every figure above comes from, so a
     chart cannot disagree with the number printed beside it. The arithmetic lives in
     lib/accounting/saas-charts.ts with tests — see its header for what a reconstructed
     trend can and cannot see, and for why `mrr_snapshots` was not used. */
  const lifespans = all.map((s) => ({
    startDate: s.start_date,
    mrr: recurringMrr(s),
    status: s.status,
    updatedAt: s.updated_at,
  }));
  const curve = retentionCurve(cohorts, now);

  return {
    mrr, arr, activeCustomers, arpc,
    newMRR30d,
    newCustomers30d: newSubs30d.length,
    churnMRR30d,
    churnedCustomers30d: churnedSubs30d.length,
    netMRRChange30d: newMRR30d - churnMRR30d,
    monthlyChurnRate,
    ltvEstimate,
    waterfall,
    mrrByVendor,
    mrrByTier,
    cohorts,
    mrrTrend: mrrTrend(lifespans, TREND_MONTHS, now),
    trendCaveats: trendCaveats(lifespans),
    retentionCurve: curve,
    retentionVelocity: retentionVelocity(curve),
  };
}
