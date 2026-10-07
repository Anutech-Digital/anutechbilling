/**
 * SaaS metrics — the heartbeat of a recurring revenue business.
 *
 *   MRR    Monthly Recurring Revenue (sum of active subscription MRR)
 *   ARR    MRR × 12
 *   ARPC   Average Revenue Per Customer = MRR / active customers
 *   LTV    Lifetime value ≈ ARPC / monthly churn rate
 *
 * Plus 30-day movement:
 *   New MRR        from subscriptions started in last 30 days
 *   Churn MRR      from cancelled/expired subs in last 30 days
 *   Net MRR change = New − Churn
 *
 * Plus breakdowns:
 *   MRR by vendor (Google / Microsoft / Zoho)
 *   MRR by tier (Starter / Standard / Plus / Enterprise)
 *   Cohort retention table (subs grouped by start-of-month)
 *
 * No external integration needed — everything comes from the
 * `subscriptions` table that record_payment already populates.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { Icon } from "@/components/ui/icon";
import { reconstructWaterfall, type MrrWaterfall } from "@/lib/accounting/mrr-waterfall";
import {
  mrrTrend, trendCaveats, retentionCurve, retentionVelocity,
  type MrrPoint, type RetentionPoint, type RetentionVelocity,
} from "@/lib/accounting/saas-charts";
import { MrrTrendChart, RetentionVelocityChart } from "@/components/features/accounting/saas-metrics-charts";
/* Moved here from /subscriptions, 12 Sep 2026 — it fills in the Expansion and
   Contraction the waterfall above can only print as "Not tracked". */
import { RetentionCard } from "@/components/features/subscriptions/retention-card";
import { useMrrSnapshots } from "@/lib/queries/seat-requests";
import { downloadCSV } from "@/lib/csv";
import { printReport, reportFilename } from "@/lib/reports/print";
import { rupee } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { toIstDate } from "@/lib/dates/ist";

// ────────────────────────────────────────────────────────────────
// Data hook
// ────────────────────────────────────────────────────────────────

interface SubRow {
  id:              string;
  customer_id:     string | null;
  customer_name:   string | null;
  plan:            string | null;
  vendor:          string | null;        // 'google' | 'microsoft' | 'zoho' | 'other'
  seats:           number | null;
  mrr:             number | null;
  start_date:      string;
  renewal_date:    string | null;
  status:          string;                // 'active' | 'paused' | 'expired' | 'cancelled'
  updated_at:      string;
}

interface CohortRow {
  monthLabel:    string;     // "May 2026"
  monthKey:      string;     // "2026-05"
  startedCount:  number;     // subs started in that month
  startedMRR:    number;
  retainedCount: number;     // still active today
  retentionPct:  number;
}

interface MetricsData {
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
const TREND_MONTHS = 12;

function vendorLabel(v: string | null): string {
  if (!v) return "Other";
  return v === "google"    ? "Google Workspace"
       : v === "microsoft" ? "Microsoft 365"
       : v === "zoho"      ? "Zoho"
       :                     v.charAt(0).toUpperCase() + v.slice(1);
}

function tierFromPlan(plan: string | null): string {
  if (!plan) return "Unknown";
  const p = plan.toLowerCase();
  if (p.includes("starter"))    return "Starter";
  if (p.includes("standard"))   return "Standard";
  if (p.includes("plus"))       return "Plus";
  if (p.includes("enterprise")) return "Enterprise";
  return plan;
}

function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);                  // "2026-05"
}
function monthLabel(d: Date): string {
  return d.toLocaleString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
}

/**
 * One column of the waterfall.
 *
 * `amount === null` is the whole reason this component exists: it renders `—`,
 * never ₹0. Zero would tell the owner "nobody upgraded this month"; the truth is
 * "this database does not record upgrades". Those lead to opposite decisions.
 */
function Step({
  label, amount, sign, tone, note,
}: {
  label:  string;
  amount: number | null;
  sign?:  "+" | "−";
  tone?:  "emerald" | "rose" | "neutral";
  note?:  string;
}) {
  const toneClass =
    amount === null ? "text-ink-3"
      : tone === "emerald" ? "text-emerald-700"
      : tone === "rose"    ? "text-rose-700"
      :                      "text-ink";

  return (
    <div className="print-keep">
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">
        {label}
      </div>
      <div className={`font-serif text-xl mt-1 ${toneClass}`}>
        {amount === null ? "—" : `${sign ?? ""}${rupee(Math.abs(amount))}`}
      </div>
      {note && (
        <div className="text-xs text-ink-3 mt-0.5 leading-snug">{note}</div>
      )}
    </div>
  );
}

function WaterfallCard({ w }: { w: MrrWaterfall }) {
  const reconciles = w.unexplained === 0;

  return (
    <Card className="p-5 md:p-6 mb-6 print-keep">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">
            MRR waterfall — last 30 days
          </div>
          <div className="text-xs text-ink-3 mt-0.5">
            Starting + New + Expansion − Contraction − Churn = Ending
          </div>
        </div>
        <Badge kind={w.basis === "ledger" ? "success" : "warning"}>
          {w.basis === "ledger" ? "From ledger" : "Reconstructed"}
        </Badge>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
        <Step label="Starting MRR"  amount={w.startingMrr} tone="neutral" />
        <Step label="New"           amount={w.newMrr}      sign="+" tone="emerald" />
        <Step label="Expansion"     amount={w.expansion}   sign="+" tone="emerald" note={w.expansion === null ? "Not tracked" : undefined} />
        <Step label="Contraction"   amount={w.contraction} sign="−" tone="rose"    note={w.contraction === null ? "Not tracked" : undefined} />
        <Step label="Churn"         amount={w.churnedMrr}  sign="−" tone="rose" />
        <Step label="Ending MRR"    amount={w.endingMrr}   tone="neutral" />
      </div>

      {/* The residual. Shown BECAUSE it is uncomfortable — its size is the
          honest measure of how much this report cannot see. */}
      {!reconciles && (
        <div className="mt-4 pt-4 border-t border-hairline flex items-baseline gap-2">
          <span className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">
            Unexplained movement
          </span>
          <span className="font-mono text-sm text-amber-ink">
            {w.unexplained > 0 ? "+" : "−"}{rupee(Math.abs(w.unexplained))}
          </span>
        </div>
      )}

      {w.notes.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {w.notes.map((n, i) => (
            <li key={i} className="flex gap-2 text-xs text-ink-3 leading-relaxed">
              <Icon name="info" className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{n}</span>
            </li>
          ))}
          <li className="flex gap-2 text-xs text-ink-3 leading-relaxed">
            <Icon name="info" className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              Churn timing uses <span className="font-mono">updated_at</span> as a proxy —
              subscriptions have no cancellation date, and that field moves on any edit,
              so churn here can be overstated.
            </span>
          </li>
        </ul>
      )}
    </Card>
  );
}

function useSaasMetrics() {
  return useQuery({
    queryKey: ["accounting", "saas-metrics"],
    queryFn: async (): Promise<MetricsData> => {
      const supabase = createClient();
      /* R-265: every subscription, paged — a bare select stops at 1000 and MRR/ARR/churn
         would silently count only the first 1000. */
      const subs = await fetchAllRows((a, b) => supabase
        .from("subscriptions")
        .select("id, customer_id, customer_name, plan, vendor, seats, mrr, start_date, renewal_date, status, updated_at")
        .order("id")
        .range(a, b));

      const all: SubRow[] = subs as SubRow[];
      const active = all.filter((s) => s.status === "active");

      const mrr = active.reduce((s, x) => s + (x.mrr ?? 0), 0);
      const arr = mrr * 12;
      const activeCustomers = new Set(active.map((s) => s.customer_id ?? s.id)).size;
      const arpc = activeCustomers > 0 ? Math.round(mrr / activeCustomers) : 0;

      // 30-day window
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const thirtyDaysAgoISO = thirtyDaysAgo.toISOString();
      const thirtyDaysAgoDate = toIstDate(thirtyDaysAgo);

      const newSubs30d   = all.filter((s) => s.start_date >= thirtyDaysAgoDate);
      const churnedSubs30d = all.filter((s) =>
        (s.status === "cancelled" || s.status === "expired") &&
        s.updated_at >= thirtyDaysAgoISO,
      );

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
          mrr: s.mrr ?? 0,
          startDate: s.start_date ?? null,
          endDate: (s.status === "cancelled" || s.status === "expired")
            ? (s.updated_at ?? null)
            : null,
          status: s.status,
        })),
        thirtyDaysAgoISO,
        now.toISOString(),
      );

      const newMRR30d   = newSubs30d.reduce((s, x) => s + (x.mrr ?? 0), 0);
      const churnMRR30d = churnedSubs30d.reduce((s, x) => s + (x.mrr ?? 0), 0);

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
        cur.mrr += s.mrr ?? 0;
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
        cur.mrr += s.mrr ?? 0;
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
        cur.startedMRR   += s.mrr ?? 0;
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
        mrr: s.mrr,
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
    },
  });
}

// ────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────

export default function SaasMetricsPage() {
  const { data, isLoading } = useSaasMetrics();
  /* The monthly snapshots the retention card compares. Written by the mrr-snapshot cron;
     the card renders its own "not enough history yet" state when there are fewer than
     two, which is the honest answer until that job has run twice. */
  const { data: snapshotRows } = useMrrSnapshots();
  const mrrSnapshots = React.useMemo(() => snapshotRows ?? [], [snapshotRows]);

  /**
   * CSV for the CA / board pack.
   *
   * Untracked components are written as the literal string "not tracked", not as
   * an empty cell and never as 0 — a blank in a spreadsheet gets SUMmed as zero
   * the moment somebody drags a formula down the column, which silently turns
   * "we don't know" into "it was nothing".
   */
  const exportCSV = React.useCallback(() => {
    if (!data) return;
    const w = data.waterfall;
    const na = (n: number | null) => (n === null ? "not tracked" : n);

    downloadCSV(
      `${reportFilename("saas-metrics")}.csv`,
      ["Metric", "Value"],
      [
        ["MRR", data.mrr],
        ["ARR", data.arr],
        ["Active customers", data.activeCustomers],
        ["ARPC", data.arpc],
        ["Monthly churn rate %", data.monthlyChurnRate.toFixed(2)],
        ["Estimated LTV", data.ltvEstimate],
        ["", ""],
        ["— MRR waterfall (last 30 days) —", ""],
        ["Basis", w.basis],
        ["Starting MRR", w.startingMrr],
        ["New MRR", w.newMrr],
        ["Expansion MRR", na(w.expansion)],
        ["Contraction MRR", na(w.contraction)],
        ["Churned MRR", w.churnedMrr],
        ["Ending MRR", w.endingMrr],
        ["Unexplained movement", w.unexplained],
        ...w.notes.map((n, i): [string, string] => [`Note ${i + 1}`, n]),
      ],
    );
  }, [data]);

  if (isLoading) {
    return (
      <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto">
        <Skeleton className="h-10 w-64 mb-6" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          {[1,2,3,4].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data) return null;

  const noData = data.mrr === 0 && data.activeCustomers === 0;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto">
      {/* Header */}
      <div className="mb-6 flex flex-col md:flex-row md:items-start md:justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Accounting</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">SaaS Metrics</h1>
          <p className="text-sm text-ink-3 mt-1 max-w-2xl">
            Your recurring revenue business at a glance.
            MRR (Monthly Recurring Revenue), churn, lifetime value — the metrics
            investors look at first.
          </p>
        </div>
        {/* no-print: the buttons must not appear in the PDF they produce. */}
        <div className="flex items-center gap-2 no-print shrink-0">
          <Button variant="outline" icon="download" onClick={exportCSV} disabled={!data}>
            CSV
          </Button>
          <Button
            variant="outline"
            icon="printer"
            onClick={() => printReport(reportFilename("saas-metrics"))}
            disabled={!data}
          >
            PDF
          </Button>
        </div>
      </div>

      {noData ? (
        <Card className="py-2">
          <EmptyState
            icon="trending_up"
            title="No active subscriptions yet"
            body={
              <>
                MRR data comes from <Link href="/subscriptions" className="text-amber-ink underline">active subscriptions</Link>.
                Record a payment on a paid quote (annual commitment) and a subscription
                will be auto-created — then this page lights up.
              </>
            }
          />
        </Card>
      ) : (
        <>
          {/* Headline metrics */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4 mb-6">
            <KPI label="MRR"                value={rupee(data.mrr)}              hint="Monthly recurring" big />
            <KPI label="ARR"                value={rupee(data.arr)}              hint="MRR × 12" />
            <KPI label="Active customers"   value={`${data.activeCustomers}`}    hint="With active subs" />
            <KPI label="ARPC"               value={rupee(data.arpc)}             hint="Per customer / month" />
          </div>

          {/* 30-day movement */}
          <Card className="p-5 md:p-6 mb-6">
            <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-4">
              Last 30 days movement
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 md:gap-6">
              <Movement
                label="New MRR added"
                amount={data.newMRR30d}
                count={data.newCustomers30d}
                tone="emerald"
                sign="+"
              />
              <Movement
                label="Churn MRR lost"
                amount={data.churnMRR30d}
                count={data.churnedCustomers30d}
                tone="rose"
                sign="−"
              />
              <Movement
                label="Net change"
                amount={data.netMRRChange30d}
                count={data.newCustomers30d - data.churnedCustomers30d}
                tone={data.netMRRChange30d >= 0 ? "emerald" : "rose"}
                sign={data.netMRRChange30d >= 0 ? "+" : ""}
                emphasis
              />
              <div className="md:border-l md:border-hairline md:pl-6">
                <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                  Estimated LTV
                </div>
                <div className="font-serif text-2xl text-ink mt-1">{rupee(data.ltvEstimate)}</div>
                <div className="text-xs text-ink-3 mt-1 leading-relaxed">
                  ARPC ÷ monthly churn ({data.monthlyChurnRate.toFixed(1)}%/mo)
                </div>
              </div>
            </div>
          </Card>

          <WaterfallCard w={data.waterfall} />

          {/* ── Retention, moved here from /subscriptions on 12 Sep 2026 ──────────
              It sits directly under the waterfall because it is the SAME six-part
              decomposition — and it is the honest version of it. The waterfall is
              reconstructed from current `subscriptions` rows, so it can only print "Not
              tracked" for Expansion and Contraction; this card compares two monthly
              snapshots and therefore knows both.

              It was on the Subscriptions page, which is an operating screen — a list you
              work through. A period-over-period revenue comparison is not something you
              act on there, and having half the decomposition on one page and half on
              another is how two numbers about the same month end up disagreeing with
              nobody noticing. */}
          <RetentionCard snapshots={mrrSnapshots} />

          {/* The two charts. Placed after the waterfall and before the breakdowns, because
              the waterfall answers "what moved last month" and these answer "what has been
              happening" — the reader needs the recent fact before the trend it sits in.

              Both take data computed in useSaasMetrics; neither computes anything itself.
              See lib/accounting/saas-charts.ts for why the trend is reconstructed from
              `subscriptions` rather than read from the (empty) `mrr_snapshots` table. */}
          <div className="grid grid-cols-1 gap-6 mb-6 xl:grid-cols-2">
            <MrrTrendChart points={data.mrrTrend} caveats={data.trendCaveats} />
            <RetentionVelocityChart curve={data.retentionCurve} velocity={data.retentionVelocity} />
          </div>

          {/* MRR breakdown */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
            <BreakdownCard title="MRR by vendor"  rows={data.mrrByVendor.map((v) => ({ key: v.vendor, label: v.vendor, mrr: v.mrr, count: v.count, pct: v.pct }))} />
            <BreakdownCard title="MRR by tier"    rows={data.mrrByTier.map((v) => ({ key: v.tier, label: v.tier, mrr: v.mrr, count: v.count, pct: v.pct }))} />
          </div>

          {/* Cohort retention */}
          {data.cohorts.length > 0 && (
            <Card className="overflow-hidden">
              <div className="px-5 py-4 border-b border-hairline">
                <h2 className="font-serif text-lg text-ink">Cohort retention</h2>
                <p className="text-xs text-ink-3 mt-0.5">
                  How many customers from each acquisition month are still active today.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                    <tr>
                      <th className="text-left  px-4 py-3">Started in</th>
                      <th className="text-right px-4 py-3">New subs</th>
                      <th className="text-right px-4 py-3">Started MRR</th>
                      <th className="text-right px-4 py-3">Still active</th>
                      <th className="text-right px-4 py-3">Retention</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline">
                    {data.cohorts.map((c) => (
                      <tr key={c.monthKey} className="hover:bg-paper-2/40">
                        <td className="px-4 py-3 font-medium text-ink">{c.monthLabel}</td>
                        <td className="px-4 py-3 text-right font-mono text-ink-2">{c.startedCount}</td>
                        <td className="px-4 py-3 text-right font-mono text-ink-2">{rupee(c.startedMRR)}</td>
                        <td className="px-4 py-3 text-right font-mono text-ink-2">{c.retainedCount}</td>
                        <td className="px-4 py-3 text-right">
                          <Badge color={c.retentionPct >= 80 ? "emerald" : c.retentionPct >= 60 ? "amber" : "rose"}>
                            {c.retentionPct.toFixed(0)}%
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Insights footer */}
          {data.mrr > 0 && (
            <Card className="p-5 mt-6 bg-paper-2/30">
              <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
                <Icon name="sparkles" size={12} className="text-amber inline mr-1 align-text-bottom" />
                What this means
              </div>
              <ul className="text-sm text-ink-2 space-y-1.5 list-disc pl-5 leading-relaxed">
                <li>
                  Your business generates <b>₹{(data.mrr / 1000).toFixed(0)}K/month</b> in recurring revenue
                  ({data.activeCustomers} customers, average <b>{rupee(data.arpc)}/customer/month</b>).
                </li>
                {data.netMRRChange30d > 0 && (
                  <li className="text-emerald">
                    <b>+{rupee(data.netMRRChange30d)}</b> net MRR growth in the last 30 days — positive momentum.
                  </li>
                )}
                {data.netMRRChange30d < 0 && (
                  <li className="text-rose">
                    <b>{rupee(Math.abs(data.netMRRChange30d))}</b> net MRR decline in the last 30 days — investigate churn.
                  </li>
                )}
                {data.monthlyChurnRate > 5 && (
                  <li className="text-amber-ink">
                    Monthly churn is {data.monthlyChurnRate.toFixed(1)}% — the SaaS benchmark is below 3%/mo. Review your renewal automation.
                  </li>
                )}
                {/* "Excellent retention" needs something to have been retained THROUGH.
                    This line used to fire on `churn <= 3%` alone, so a book whose every
                    subscription started this month — 0% churn because nothing has had time
                    to leave — was congratulated on its retention. The retention-velocity
                    chart directly above refuses to draw a number in exactly that case, and
                    a page that says "not measurable yet" in one card and "excellent" in the
                    next has told the owner nothing. */}
                {data.monthlyChurnRate <= 3 && data.activeCustomers > 0 && (
                  data.retentionVelocity.pointsPerMonth !== null ? (
                    <li className="text-emerald">
                      Churn {data.monthlyChurnRate.toFixed(1)}%/mo — excellent retention.
                    </li>
                  ) : (
                    <li className="text-ink-2">
                      Churn is {data.monthlyChurnRate.toFixed(1)}%/mo, but nothing has been on
                      the book long enough to churn yet — that is a young book, not proven
                      retention. Come back once there are two months of cohorts.
                    </li>
                  )
                )}
                <li>
                  At current ARPC + churn, average customer ka lifetime value <b>{rupee(data.ltvEstimate)}</b> hai.
                  Yani har new customer acquire karne pe ₹{(data.ltvEstimate / 4).toFixed(0)} tak spend karna ROI positive hai (4× LTV/CAC ratio).
                </li>
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Primitives
// ────────────────────────────────────────────────────────────────

function KPI({
  label, value, hint, big,
}: { label: string; value: string; hint?: string; big?: boolean }) {
  return (
    <Card className="p-3 md:p-4">
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">{label}</div>
      <div className={`font-serif ${big ? "text-3xl md:text-4xl" : "text-2xl md:text-3xl"} text-ink leading-tight`}>
        {value}
      </div>
      {hint && <div className="text-xs text-ink-3 mt-1">{hint}</div>}
    </Card>
  );
}

function Movement({
  label, amount, count, tone, sign, emphasis,
}: {
  label: string;
  amount: number;
  count: number;
  tone: "emerald" | "rose";
  sign: string;
  emphasis?: boolean;
}) {
  const colorClass = tone === "emerald" ? "text-emerald" : "text-rose";
  return (
    <div>
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">{label}</div>
      <div className={`font-serif ${emphasis ? "text-2xl" : "text-xl"} ${colorClass} leading-tight`}>
        {sign}{rupee(Math.abs(amount))}
      </div>
      <div className="text-xs text-ink-3 mt-1">
        {count} {count === 1 ? "customer" : "customers"}
      </div>
    </div>
  );
}

function BreakdownCard({
  title, rows,
}: {
  title: string;
  rows: Array<{ key: string; label: string; mrr: number; count: number; pct: number }>;
}) {
  return (
    <Card className="p-5">
      <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-3">{title}</div>
      {rows.length === 0 ? (
        <div className="text-sm text-ink-3 py-4">No active subscriptions to break down.</div>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.key}>
              <div className="flex items-baseline justify-between mb-1.5">
                <div className="text-sm text-ink">
                  {r.label}
                  <span className="text-ink-3 text-xs ml-1.5">· {r.count}</span>
                </div>
                <div className="text-sm font-mono font-semibold text-ink">{rupee(r.mrr)}</div>
              </div>
              <div className="h-1.5 rounded-full bg-paper-2 overflow-hidden">
                <div
                  className="h-full bg-amber rounded-full transition-all"
                  style={{ width: `${Math.max(2, r.pct)}%` }}
                />
              </div>
              <div className="text-xs text-ink-3 mt-0.5">{r.pct.toFixed(1)}% of MRR</div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
