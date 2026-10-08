/**
 * Reports & Analytics — ab HAR aankda asli hai, ya saaf kehta hai ki nahi hai.
 *
 * 1 Sep 2026 ke audit ne is page par paanch jhooth naape the, sab asli
 * numbers ke BEECH me baithe hue: 12-mahine ka MRR trend hardcode tha,
 * funnel (Leads 120 → Won 22) hardcode tha, "Margin ARR" hamesha 17% tha,
 * "renewal risk" subscription ki ID ke aksharon se nakli NPS/last-login
 * banata tha, aur KPI ke saare trend-badge (plus-barah-pratishat jaisi
 * string-literals) kahaani the.
 * Demo ke liye theek tha; "Live business insights" heading ke neeche wahi
 * cheez jhooth ban jati hai jo saas-metrics wala page kabhi nahi karta
 * (wahan expansion ka "—" hota hai, ₹0 nahi).
 *
 * Ab ka niyam: aankda ya to naapa hua hai (source comment ke saath), ya
 * dikhaya hi nahi jata — uski jagah likha hota hai ki wo KAB se aayega.
 *   - MRR/ARR/seats: live subscriptions se.
 *   - MRR history: mrr_snapshots (mahine ki 1 ko cron likhta hai) — jitne
 *     mahine asli hain utne hi bindu.
 *   - Funnel: leads ki asli stage-ginti (aaj ka pipeline, conversion nahi —
 *     conversion ke liye stage-history chahiye jo abhi record nahi hoti).
 *   - Risk: sirf seat-utilisation (used/seats) — jo sach me pata hai.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useSubscriptions } from "@/lib/queries/subscriptions";
import { hasNoPrice } from "@/lib/subscriptions/list-price-mrr";
import { useCustomers } from "@/lib/queries/customers";
import { useLeadStageCounts } from "@/lib/queries/leads";
import { useMrrSnapshots } from "@/lib/queries/seat-requests";
import { KPI } from "@/components/shared/kpi";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError, LoadErrorBanner } from "@/components/shared/load-error";
import { Card } from "@/components/ui/card";
import { rupee } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { NavDirectory } from "@/components/layout/nav-directory";
import { LEAD_STAGES } from "@/lib/leads/stage-meta";
import { DealsReportCard } from "@/components/features/deals/deals-report-card";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
} from "recharts";
import type { Lead, Subscription } from "@/lib/supabase/database.types";

/** "2026-08-01" → "Aug '26" — chart ki dhuri ke liye. */
function periodLabel(period: string): string {
  const d = new Date(period + "T00:00:00Z");
  return `${d.toLocaleString("en-IN", { month: "short", timeZone: "UTC" })} '${String(d.getUTCFullYear() % 100).padStart(2, "0")}`;
}

// ─── Custom Recharts tooltip ──────────────────────────────────────────────────
function RupeeTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    // Glass tooltip: translucent + blurred so the series under the cursor stays
    // readable through it, instead of a solid panel hiding the very point being
    // inspected. Figures use <Money> so they don't reflow as the cursor moves
    // across the chart.
    <div className="rounded-lg border border-hairline bg-paper/90 backdrop-blur-md px-3 py-2 shadow-md text-xs">
      <p className="mb-1 font-semibold text-ink">{label}</p>
      {payload.map((p: any) => (
        <p key={p.dataKey} style={{ color: p.color }} className="tabular-nums tracking-tight">
          {p.name}: {rupee(p.value, { compact: true })}
        </p>
      ))}
    </div>
  );
}

// ─── Donut chart legend ───────────────────────────────────────────────────────
function DonutLegend({
  slices,
}: {
  slices: Array<{ label: string; value: number; color: string; fmt: (v: number) => string }>;
}) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  return (
    <div className="space-y-2">
      {slices.map((s) => (
        <div
          key={s.label}
          className="grid items-center gap-2 text-xs"
          style={{ gridTemplateColumns: "12px 1fr auto auto" }}
        >
          <span
            className="rounded-sm"
            style={{ width: 10, height: 10, background: s.color }}
          />
          <span className="text-ink">{s.label}</span>
          <span className="tabular-nums text-ink-3">{s.fmt(s.value)}</span>
          <span className="tabular-nums text-ink-3 min-w-[30px] text-right">
            {Math.round((s.value / total) * 100)}%
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Section card ─────────────────────────────────────────────────────────────
function ReportCard({
  title,
  subtitle,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("p-5", className)}>
      <p className="text-sm font-semibold text-ink leading-tight">{title}</p>
      {subtitle && <p className="text-xs text-ink-3 mt-0.5 mb-4">{subtitle}</p>}
      {!subtitle && <div className="mb-4" />}
      {children}
    </Card>
  );
}

// ─── Sales pipeline — leads ki ASLI stage-ginti ke labels/rang ──────────────
// Ye "funnel conversion" nahi hai: stage ka itihaas record nahi hota, sirf
// aaj ki stage — isliye card kehta hai "Pipeline today" aur % kul ka hissa
// hai, conversion nahi.
// R-290: stages, labels and order come from the one table (lib/leads/stage-meta, funnel
// order quote → demo → trial); only the bar colours are this card's own.
const PIPELINE_COLOR: Record<Lead["stage"], string> = {
  new: "#64748b", contact: "#6366f1", quote: "#C2410C", demo: "#0ea5e9",
  trial: "#f43f5e", won: "#16a34a", lost: "#94a3b8",
};
const PIPELINE_STAGES: ReadonlyArray<{ id: Lead["stage"]; label: string; color: string }> =
  LEAD_STAGES.map((s) => ({ id: s.id, label: s.label, color: PIPELINE_COLOR[s.id] }));

const PIPELINE_STAGE_IDS = PIPELINE_STAGES.map((s) => s.id);

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const subsQ  = useSubscriptions();
  const custsQ = useCustomers();
  const { data: subs,      isLoading: subsLoading  } = subsQ;
  const { data: customers, isLoading: custsLoading } = custsQ;
  /* WC-scale: exact per-stage counts from the server. This used to be useLeads() — every
     lead, cut at PostgREST's 1000 rows — counted here, so past the thousandth lead the
     pipeline card described the newest thousand. Junk is excluded, as the card always said. */
  const stageQ    = useLeadStageCounts(PIPELINE_STAGE_IDS);
  const snapshotQ = useMrrSnapshots(13);
  const { data: stageCounts = {} } = stageQ;
  const { data: snapshots } = snapshotQ;
  const { data: currentUser } = useCurrentUser();

  const loading = subsLoading || custsLoading;

  if (loading) {
    return (
      <div className="p-8 space-y-4">
        <Skeleton className="h-8 w-40" />
        <div className="grid grid-cols-6 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
        </div>
      </div>
    );
  }

  /* MRR, ARR, seats and the customer count all come from these two. If either
     failed, every KPI below would read ₹0 / 0 — say so instead, and keep the
     reports directory usable. */
  if (subsQ.isError || custsQ.isError) {
    return (
      <div className="mx-auto max-w-[1800px] px-4 md:px-8 pb-20 pt-7">
        <h1 className="mb-6 font-serif text-3xl text-ink">Reports</h1>
        <div className="mb-8">
          <LoadError what="Subscription and customer figures" onRetry={() => { void subsQ.refetch(); void custsQ.refetch(); }} />
        </div>
        <NavDirectory parentId="reports" title="All reports" />
      </div>
    );
  }
  const partialFail = stageQ.isError || snapshotQ.isError;

  // ── KPIs from real data ──────────────────────────────────────────────────
  const activeSubs = (subs ?? []).filter((s) => s.status === "active");
  const totalMrr   = activeSubs.reduce((s, x) => s + x.mrr, 0);
  const totalArr   = totalMrr * 12;
  /* R-317: active subscriptions with no price (mostly imports with no edition). They add
     ₹0 above, so MRR/ARR are a floor while this is non-zero — say so, and link to them. */
  const noPriceCount = activeSubs.filter(hasNoPrice).length;
  const custCount  = (customers ?? []).length;
  const totalSeats = activeSubs.reduce((s, x) => s + x.seats, 0);

  /* MRR history — mrr_snapshots ki asli avadhi-war ginti. Ek period me har
     customer ki apni row hoti hai, isliye period par jod. */
  const byPeriod = new Map<string, number>();
  for (const r of snapshots ?? []) {
    byPeriod.set(r.period, (byPeriod.get(r.period) ?? 0) + r.mrr);
  }
  const trendData = [...byPeriod.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([period, mrr]) => ({ month: periodLabel(period), mrr }));
  /* Trend-badge sirf tab jab do asli mahine hon — warna koi badge nahi.
     (Purana page yahan plus-barah-pratishat jaisa banaya hua badge chhapta tha.) */
  const mrrMoM =
    trendData.length >= 2 && trendData[trendData.length - 2].mrr > 0
      ? Math.round(
          ((trendData[trendData.length - 1].mrr - trendData[trendData.length - 2].mrr) /
            trendData[trendData.length - 2].mrr) * 100,
        )
      : null;

  /* Risk = sirf seat-utilisation, kyunki wahi sach me naapa hua hai.
     (Pehle yahan sub ki ID ke aksharon se "last login" aur "NPS" bante the.) */
  function riskLevel(sub: Subscription): "high" | "medium" | "low" {
    const util = sub.used / Math.max(1, sub.seats);
    return util < 0.7 ? "high" : util < 0.85 ? "medium" : "low";
  }

  const highRisk   = activeSubs.filter((s) => riskLevel(s) === "high").length;
  const mediumRisk = activeSubs.filter((s) => riskLevel(s) === "medium").length;
  const lowRisk    = activeSubs.filter((s) => riskLevel(s) === "low").length;

  /* Pipeline today — leads ki asli stage-ginti ("junk"/lost ginti me nahi). */
  const pipelineTotal = PIPELINE_STAGES.reduce((s, st) => s + (stageCounts[st.id] ?? 0), 0);
  const pipeline = PIPELINE_STAGES.map((st) => ({
    ...st,
    count: stageCounts[st.id] ?? 0,
    pct: pipelineTotal > 0 ? Math.round(((stageCounts[st.id] ?? 0) / pipelineTotal) * 100) : 0,
  }));

  /* Seats by vendor — asli; nakli 6-mahine ke stacked bars ki jagah. */
  const seatsByVendor = Object.entries(
    activeSubs.reduce<Record<string, number>>((acc, s) => {
      acc[s.vendor] = (acc[s.vendor] ?? 0) + s.seats;
      return acc;
    }, {}),
  )
    .map(([vendor, seats]) => ({ vendor, seats }))
    .sort((a, b) => b.seats - a.seats);

  // Top customers by MRR (from subs — aggregate per customer)
  const mrrByCustomer = activeSubs.reduce<Record<string, { name: string; mrr: number }>>((acc, s) => {
    const key = s.customer_id ?? s.customer_name;
    if (!acc[key]) acc[key] = { name: s.customer_name, mrr: 0 };
    acc[key].mrr += s.mrr;
    return acc;
  }, {});
  const topCustomers = Object.values(mrrByCustomer)
    .sort((a, b) => b.mrr - a.mrr)
    .slice(0, 5);

  // Revenue donut — vendor breakdown from real subs
  const mrrByVendor = activeSubs.reduce<Record<string, number>>((acc, s) => {
    acc[s.vendor] = (acc[s.vendor] ?? 0) + s.mrr * 12;
    return acc;
  }, {});

  const VENDOR_COLORS: Record<string, string> = {
    google:    "#C2410C",
    microsoft: "#4285F4",
    zoho:      "#34A853",
    other:     "#9333EA",
  };
  const VENDOR_LABELS: Record<string, string> = {
    google:    "Google Workspace",
    microsoft: "Microsoft 365",
    zoho:      "Zoho",
    other:     "Other",
  };

  const revenueSlices = Object.entries(mrrByVendor)
    .filter(([, v]) => v > 0)
    .map(([vendor, value]) => ({
      label: VENDOR_LABELS[vendor] ?? vendor,
      value,
      color: VENDOR_COLORS[vendor] ?? "#888",
      fmt:   (v: number) => rupee(v, { compact: true }),
    }));

  /* Koi floor nahi — healthy 0 ho to 0 hi dikhe. (Pehle Math.max(lowRisk, 1)
     tha: shunya ko chup-chaap ek bana deta tha.) */
  const riskSlices = [
    { label: "Healthy (≥85% used)",   value: lowRisk,    color: "#16A34A", fmt: (v: number) => `${v} subs` },
    { label: "Watch (70–85% used)",   value: mediumRisk, color: "#FBBC04", fmt: (v: number) => `${v} subs` },
    { label: "At risk (<70% used)",   value: highRisk,   color: "#EF4444", fmt: (v: number) => `${v} subs` },
  ].filter((s) => s.value > 0);

  return (
    <div className="mx-auto max-w-[1800px] px-4 md:px-8 pb-20 pt-7">
      {/* ── Page header ── */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <p className="mb-0.5 text-xs font-medium uppercase tracking-widest text-ink-3">
            Books
          </p>
          <h1 className="font-serif text-3xl text-ink">Reports</h1>
          <p className="mt-1 text-sm text-ink-3">
            Live figures from subscriptions, leads and monthly MRR snapshots
          </p>
        </div>
        {/* Deeper drill-down. (Date-range + PDF export intentionally omitted until
            implemented — no dead "coming soon" buttons in the primary slot.) */}
        <Link
          href={"/reports/profit" as never}
          className="shrink-0 self-center inline-flex items-center gap-1 rounded-md border border-hairline bg-paper px-3 py-1.5 text-sm text-ink-2 hover:bg-paper-2 hover:text-ink transition-colors"
        >
          Profit by product <span aria-hidden>→</span>
        </Link>
      </div>

      {partialFail && (
        <LoadErrorBanner onRetry={() => { void stageQ.refetch(); void snapshotQ.refetch(); }} />
      )}

      {/* ── Reports directory (S30) — every report in one place, from APP_NAV. P&L,
             Balance Sheet, GST, TDS, Aging, ESI… are no longer sidebar rows; they are
             listed here, role-filtered exactly like the sidebar. ── */}
      <div className="mb-8">
        <NavDirectory parentId="reports" title="All reports" />
      </div>

      {/* ── KPIs — sab live subscriptions se; trend-badge sirf jab history ho.
             Churn/LTV yahan nahi: unke asli hisaab /accounting/saas-metrics
             par hain, aur nakli badge se khaali jagah behtar hai. ── */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
        <KPI
          label="MRR"
          value={totalMrr}
          asCurrency
          trend={mrrMoM !== null ? `${mrrMoM > 0 ? "+" : ""}${mrrMoM}% MoM` : undefined}
          trendKind={mrrMoM === null ? undefined : mrrMoM >= 0 ? "up" : "down"}
          icon="rupee"
        />
        <KPI label="ARR" value={totalArr} asCurrency icon="trending_up" />
        <KPI label="Active subscriptions" value={activeSubs.length} icon="layers" />
        <KPI label="Seats under management" value={totalSeats} icon="users" />
        <KPI
          label="Avg MRR / customer"
          value={custCount > 0 ? Math.round(totalMrr / custCount) : 0}
          asCurrency
          icon="award"
        />
      </div>
      {noPriceCount > 0 && (
        <p role="status" className="-mt-3 mb-6 text-xs text-amber-ink">
          {noPriceCount} subscription{noPriceCount === 1 ? " has" : "s have"} no price — MRR undercounted.{" "}
          <Link href="/subscriptions?price=missing" className="font-medium underline underline-offset-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded-sm">
            Set their plan
          </Link>
        </p>
      )}

      {/* ── Row 1: MRR trend + Funnel ── */}
      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* MRR history — mrr_snapshots se, jitni asli hai utni hi. */}
        <ReportCard
          title="MRR history"
          subtitle={`Monthly snapshots · ${trendData.length} month${trendData.length === 1 ? "" : "s"} recorded`}
        >
          {trendData.length === 0 ? (
            <p className="text-sm text-ink-3 py-8 text-center">
              The first snapshot is taken on the 1st of next month.
            </p>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={trendData} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
                  <defs>
                    <linearGradient id="mrrGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#C2410C" stopOpacity={0.28} />
                      <stop offset="95%" stopColor="#C2410C" stopOpacity={0}    />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="2 4" stroke="var(--color-hairline, #e4e4e7)" />
                  <XAxis
                    dataKey="month"
                    tick={{ fontSize: 9, fill: "var(--color-ink-3, #71717a)" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 9, fill: "var(--color-ink-3, #71717a)" }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => `₹${Math.round(v / 1000)}K`}
                    width={40}
                  />
                  <Tooltip content={<RupeeTooltip />} />
                  <Area
                    type="monotone"
                    dataKey="mrr"
                    name="MRR"
                    stroke="#C2410C"
                    strokeWidth={2}
                    fill="url(#mrrGrad)"
                    dot={{ r: 3, fill: "#fff", stroke: "#C2410C", strokeWidth: 1.5 }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
              {trendData.length < 3 && (
                <p className="mt-2 text-xs text-ink-3">
                  History starts in {trendData[0].month}. A new point is added on the 1st of each month.
                </p>
              )}
            </>
          )}
        </ReportCard>

        {/* Pipeline today — leads ki asli stage-ginti */}
        <ReportCard
          title="Pipeline today"
          subtitle={`Leads by current stage · ${pipelineTotal} open + won`}
        >
          <div className="space-y-3 pt-1">
            {pipeline.map((f) => (
              <div
                key={f.label}
                className="grid items-center gap-2 text-sm"
                style={{ gridTemplateColumns: "130px 1fr 48px 36px" }}
              >
                <span className="text-ink text-xs truncate">{f.label}</span>
                <div className="h-2 rounded-full bg-paper-2 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${f.pct}%`, background: f.color }}
                  />
                </div>
                <span className="font-serif text-base tabular-nums text-right text-ink">
                  {f.count}
                </span>
                <span className="text-xs tabular-nums text-right text-ink-3">
                  {f.pct}%
                </span>
              </div>
            ))}
          </div>
        </ReportCard>
      </div>

      {/* ── Deals — win rate, avg deal, days to close, per owner (last 90 days).
             Owner / manager / sales only, like the Deals nav row. ── */}
      <DealsReportCard role={currentUser?.role} />

      {/* ── Row 2: Revenue donut + Risk donut ── */}
      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Revenue by plan / vendor */}
        <ReportCard title="Revenue by vendor" subtitle="ARR distribution">
          {revenueSlices.length === 0 ? (
            <p className="text-sm text-ink-3 py-8 text-center">
              No active subscriptions yet.
            </p>
          ) : (
            <div className="flex items-center gap-6">
              <PieChart width={160} height={160}>
                <Pie
                  data={revenueSlices}
                  cx={75}
                  cy={75}
                  innerRadius={48}
                  outerRadius={74}
                  dataKey="value"
                  strokeWidth={2}
                  stroke="var(--color-paper, #ffffff)"
                >
                  {revenueSlices.map((s, i) => (
                    <Cell key={i} fill={s.color} />
                  ))}
                </Pie>
              </PieChart>
              <DonutLegend slices={revenueSlices} />
            </div>
          )}
        </ReportCard>

        {/* Seat-utilisation risk — jo sach me naapa hua hai wahi. (Pehle yahan
            "renewal risk" tha jo sub ki ID ke aksharon se NPS/last-login
            banata tha — fiction.) */}
        <ReportCard
          title="Seat utilisation risk"
          subtitle="Under-used seats churn first · used ÷ purchased per subscription"
        >
          {riskSlices.length === 0 ? (
            <p className="text-sm text-ink-3 py-8 text-center">
              No subscriptions to analyse.
            </p>
          ) : (
            <div className="flex items-center gap-6">
              <PieChart width={160} height={160}>
                <Pie
                  data={riskSlices}
                  cx={75}
                  cy={75}
                  innerRadius={48}
                  outerRadius={74}
                  dataKey="value"
                  strokeWidth={2}
                  stroke="var(--color-paper, #ffffff)"
                >
                  {riskSlices.map((s, i) => (
                    <Cell key={i} fill={s.color} />
                  ))}
                </Pie>
              </PieChart>
              <DonutLegend slices={riskSlices} />
            </div>
          )}
        </ReportCard>
      </div>

      {/* ── Row 3: Seats by vendor + Top customers ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Seats by vendor — asli; margin ke liye P&L report hai (wahan basis
            ke saath aata hai — billed ya estimated, chhupa kar nahi). */}
        <ReportCard title="Seats by vendor" subtitle="Active subscriptions today">
          {seatsByVendor.length === 0 ? (
            <p className="text-sm text-ink-3 py-8 text-center">No active subscriptions yet.</p>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart
                  data={seatsByVendor}
                  margin={{ left: 0, right: 8, top: 4, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="2 4" stroke="var(--color-hairline, #e4e4e7)" vertical={false} />
                  <XAxis
                    dataKey="vendor"
                    tick={{ fontSize: 9, fill: "var(--color-ink-3, #71717a)" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 9, fill: "var(--color-ink-3, #71717a)" }}
                    axisLine={false}
                    tickLine={false}
                    width={40}
                  />
                  <Tooltip />
                  <Bar dataKey="seats" name="Seats" fill="#C2410C" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
              <p className="mt-2 text-xs text-ink-3">
                Vendor margin in ₹ is on the <Link href={"/accounting/pnl" as never} className="underline">P&amp;L report</Link>,
                with the basis for each figure.
              </p>
            </>
          )}
        </ReportCard>

        {/* Top customers */}
        <ReportCard title="Top customers" subtitle="By ARR contribution">
          {topCustomers.length === 0 ? (
            <p className="text-sm text-ink-3 py-8 text-center">
              No customer data yet.
            </p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {topCustomers.map((c) => (
                  <tr
                    key={c.name}
                    className="border-b border-hairline last:border-0"
                  >
                    <td className="py-2.5 text-ink">{c.name}</td>
                    <td className="py-2.5 text-right tabular-nums font-serif text-base text-ink">
                      {rupee(c.mrr * 12, { compact: true })}
                    </td>
                    {/* Share of MRR — asli. (Pehle yahan har row par "17% margin"
                        chhapta tha jo ek hardcoded guess tha.) */}
                    <td className="py-2.5 text-right text-xs tabular-nums text-ink-3">
                      {totalMrr > 0 ? Math.round((c.mrr / totalMrr) * 100) : 0}% of MRR
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </ReportCard>
      </div>
    </div>
  );
}
