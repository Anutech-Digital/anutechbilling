/**
 * Executive marketing report — /marketing/reports
 *
 * ─── WHAT THIS PAGE WILL SHOW YOU TODAY, AND WHY THAT IS CORRECT ─────────────
 * Measured 13 Aug 2026: this workspace has ₹4,000 of recorded marketing spend
 * against ₹66,64,199 of won lead value. Divide those and you get a ROAS of about
 * 1,650×. Every "executive dashboard" instinct says render it big and green.
 *
 * It is rendered as "Not enough spend recorded" instead, because the number says
 * nothing about the marketing and everything about the bookkeeping — and an
 * executive who sees 1,650× moves real budget on the strength of one ₹4,000 row.
 * The withholding logic lives in lib/marketing/channel-economics.ts where it is
 * tested; this page only renders what that module is willing to stand behind.
 *
 * The channel leaderboard, by contrast, is fully populated and genuinely useful:
 * 61 leads across 8 sources with real win rates and real won value. That is the
 * part of this page that can be acted on today.
 */
"use client";

import * as React from "react";
import {
  ResponsiveContainer, ComposedChart, Bar, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { rupee, cn } from "@/lib/utils";
import { recommendationFor, type ChannelStat } from "@/lib/marketing/channel-economics";
import { sourceLabel } from "@/lib/leads/lead-sources";
import { useMarketingReport, channelsToCsv, type RangeKey } from "@/lib/queries/marketing";
import { logExport } from "@/lib/export-log";

const RANGES: TabBarItem[] = [
  { id: "this_month",   label: "This month" },
  { id: "last_quarter", label: "Last 3 months" },
  { id: "ytd",          label: "This FY" },
  { id: "all",          label: "All time" },
];

export default function MarketingReportsPage() {
  const [range, setRange] = React.useState<RangeKey>("ytd");
  const { data, isLoading, error } = useMarketingReport(range);

  const onExportCsv = () => {
    if (!data) return;
    const csv = channelsToCsv(data.report, data.range);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `marketing-channels-${data.range.start}-to-${data.range.end}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    void logExport({ what: "marketing-channels", rowCount: Math.max(0, csv.split("\n").length - 1), format: "csv" });
  };

  return (
    <div className="mx-auto max-w-[1240px] p-4 md:p-6 lg:p-8 space-y-5">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Marketing</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Executive report</h1>
          <p className="text-sm text-ink-3 mt-1">
            Ad spend against revenue, by channel. Figures are withheld rather than estimated where the data cannot support them.
          </p>
        </div>
        <Button variant="outline" icon="download" size="sm" onClick={onExportCsv} disabled={!data}>
          Export CSV
        </Button>
      </header>

      <TabBar items={RANGES} value={range} onChange={(v) => setRange(v as RangeKey)} />

      {isLoading ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
            {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
          </div>
          <Skeleton className="h-72 w-full" />
        </div>
      ) : error ? (
        <Card className="py-2">
          <EmptyState icon="alert" title="Could not load the report" body={(error as Error).message} />
        </Card>
      ) : !data ? null : (
        <>
          {/* ── Data gaps, before any number ──────────────────────────────
              Deliberately above the cards. A caveat printed under a big green
              metric is a caveat nobody reads. */}
          {data.gaps.length > 0 && (
            <Card className="p-4 border-amber/40 bg-amber-soft/30">
              <div className="flex items-start gap-2.5">
                <Icon name="alert" size={16} className="text-amber-ink shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink mb-1">
                    What this report cannot tell you yet
                  </p>
                  <ul className="space-y-1 text-[13px] text-ink-2 list-disc pl-4">
                    {data.gaps.map((g, i) => <li key={i}>{g}</li>)}
                  </ul>
                </div>
              </div>
            </Card>
          )}

          <ExecutiveCards
            spend={data.report.totals.spend}
            wonValue={data.report.totals.wonValue}
            collected={data.collected}
            projectCollected={data.projectCollected}
            won={data.report.totals.won}
            blendedRoas={data.report.blendedRoas}
            blendedNote={data.report.blendedNote}
          />

          <SpendVsRevenue monthly={data.monthly} />

          <ChannelTable channels={data.report.channels} unattributed={data.report.unattributed}
                        unattributedShare={data.report.totals.unattributedShare} />

          <Funnel steps={data.funnel} />

          <AiAdvisorPanel canAdvise={data.report.blendedRoas !== null} />
        </>
      )}
    </div>
  );
}

// ── Executive cards ─────────────────────────────────────────────────────────

/**
 * One executive metric.
 *
 * `withheld` renders an em-dash as the value and puts the reason in the sub-line.
 * A first version passed the whole sentence in as the value and got a three-line
 * paragraph set in display serif — and passed the reason to `Card`'s `title`
 * prop, which renders a VISIBLE heading rather than a tooltip, so the sentence
 * appeared twice, once above the label. A metric slot holds a number or a dash;
 * prose belongs underneath it.
 */
function Metric({ label, value, sub, withheld }: {
  label: string; value?: React.ReactNode; sub?: string; withheld?: boolean;
}) {
  return (
    <Card className="p-4">
      <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-1.5">{label}</p>
      <p
        className={cn("font-serif text-2xl leading-none", withheld ? "text-ink-3" : "text-ink")}
        title={withheld ? sub : undefined}
      >
        {withheld ? "—" : value}
      </p>
      {sub && <p className="text-xs text-ink-2 mt-2 leading-relaxed">{sub}</p>}
    </Card>
  );
}

function ExecutiveCards({ spend, wonValue, collected, projectCollected, won, blendedRoas, blendedNote }: {
  spend: number; wonValue: number; collected: number; projectCollected: number; won: number;
  blendedRoas: number | null; blendedNote: string | null;
}) {
  // CAC is spend ÷ won deals — and it is only meaningful when the spend behind it
  // is real. The same threshold that gates ROAS gates this.
  const cacSafe = blendedRoas !== null && won > 0;

  return (
    <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
      <Metric
        label="Total ad spend"
        value={rupee(spend)}
        sub={spend === 0 ? "Nothing tagged to a channel in this period" : "Marketing expenses tagged to a channel"}
      />
      {/* "Revenue collected" is payments; "won lead value" is the deal value on
          leads marked won. They differ legitimately — a payment can arrive for a
          lead closed in an earlier period, and one customer can pay twice — so
          both are named for what they are. Labelling both "revenue" is how a
          dashboard ends up with two different truths on one screen. */}
      <Metric
        label="Revenue collected"
        value={rupee(collected)}
        sub={`Payments received${projectCollected > 0 ? ` (incl. ${rupee(projectCollected)} from projects)` : ""}. Won lead value ${rupee(wonValue)} across ${won} ${won === 1 ? "lead" : "leads"}.`}
      />
      <Metric
        label="Return on ad spend"
        value={blendedRoas === null ? undefined : `${blendedRoas.toFixed(1)}×`}
        withheld={blendedRoas === null}
        sub={blendedNote ?? "Revenue ÷ spend, across all tagged channels"}
      />
      <Metric
        label="Customer acquisition cost"
        value={cacSafe ? rupee(Math.round(spend / won)) : undefined}
        withheld={!cacSafe}
        sub={cacSafe
          ? `Spend ÷ ${won} leads won. The funnel counts payments, which is a different number.`
          : "Not computable yet — needs marketing spend tagged to a channel."}
      />
    </div>
  );
}

// ── Spend vs revenue ────────────────────────────────────────────────────────

function SpendVsRevenue({ monthly }: { monthly: { month: string; spend: number; revenue: number }[] }) {
  if (monthly.length === 0) {
    return (
      <Card className="py-2">
        <EmptyState icon="chart" title="No spend or revenue in this period" body="Widen the date range, or record a marketing expense and tag its channel." />
      </Card>
    );
  }

  // With no spend anywhere in the range, Recharts auto-scales the spend axis to
  // 0-4 and renders a ₹0/₹1/₹2/₹3/₹4 ladder beside invisible bars. That reads as
  // a broken chart. An axis for data that does not exist is worse than no axis,
  // so the spend series is dropped entirely and the reason is stated.
  const hasSpend = monthly.some((m) => m.spend > 0);

  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <p className="text-sm font-semibold text-ink">
          {hasSpend ? "Monthly ad spend vs revenue collected" : "Monthly revenue collected"}
        </p>
        {monthly.length < 2 && (
          <Badge kind="muted" size="sm">One month — no trend yet</Badge>
        )}
      </div>
      <p className="text-xs text-ink-2 mb-3 leading-relaxed">
        {hasSpend
          ? "Two axes: spend and revenue differ by orders of magnitude, so one shared scale would flatten the bars to a line."
          : "No ad spend is tagged to a channel in this range, so there is nothing to plot against revenue — the spend axis is left out rather than drawn empty."}
      </p>
      <div className="h-72 -ml-2">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={monthly}>
            <CartesianGrid stroke="hsl(var(--hairline))" vertical={false} />
            <XAxis dataKey="month" tick={{ fontSize: 11, fill: "hsl(var(--ink-3))" }} stroke="hsl(var(--hairline))" />
            {/* Two axes only when there IS spend: the two series differ by orders
                of magnitude (₹4,000 against ₹69,55,963), so one shared scale
                would flatten the bars to an invisible line. */}
            {hasSpend && (
              <YAxis yAxisId="spend" tick={{ fontSize: 11, fill: "hsl(var(--ink-3))" }} stroke="hsl(var(--hairline))"
                     tickFormatter={(v: number) => rupee(v, { compact: true })} />
            )}
            <YAxis yAxisId="rev" orientation={hasSpend ? "right" : "left"}
                   tick={{ fontSize: 11, fill: "hsl(var(--ink-3))" }} stroke="hsl(var(--hairline))"
                   tickFormatter={(v: number) => rupee(v, { compact: true })} />
            <Tooltip
              formatter={(v: number, name: string) => [rupee(v), name]}
              contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid hsl(var(--hairline))", background: "hsl(var(--paper))" }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Area yAxisId="rev" type="monotone" dataKey="revenue" name="Revenue collected"
                  stroke="hsl(var(--emerald))" fill="hsl(var(--emerald-soft))" strokeWidth={2} />
            {hasSpend && (
              <Bar yAxisId="spend" dataKey="spend" name="Ad spend" fill="hsl(var(--amber))" radius={[4, 4, 0, 0]} maxBarSize={48} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

// ── Channel leaderboard ─────────────────────────────────────────────────────

const ACTION_TONE: Record<string, "success" | "warning" | "danger" | "info" | "muted"> = {
  scale: "success", optimise: "info", cut: "danger",
  review: "warning", track_spend: "muted", not_a_channel: "muted",
};

function ChannelRow({ c }: { c: ChannelStat }) {
  const rec = recommendationFor(c);
  return (
    <tr className="border-b border-hairline last:border-0">
      <td className="px-3 py-2.5 align-top">
        <div className="font-medium text-sm text-ink">{sourceLabel(c.channel)}</div>
        {/* 12px, not 10px. These notes are the most important content in the
            table — they are the reason a figure is a dash instead of a number —
            and a first pass set them SMALLER than everything around them. The
            design system reserves 10px for uppercase micro-labels, not prose. */}
        {c.notes.length > 0 && (
          <ul className="mt-1 space-y-1">
            {c.notes.map((n, i) => (
              <li key={i} className="text-xs text-ink-2 leading-relaxed max-w-[30rem]">{n}</li>
            ))}
          </ul>
        )}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-sm align-top">{c.leads}</td>
      <td className="px-3 py-2.5 text-right tabular-nums text-sm align-top">{c.won}</td>
      <td className="px-3 py-2.5 text-right tabular-nums text-sm align-top">
        {c.winRate === null ? <span className="text-ink-3">—</span> : `${Math.round(c.winRate * 100)}%`}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-sm align-top">{rupee(c.wonValue)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums text-sm align-top">
        {c.spend === null ? <span className="text-ink-3">—</span> : rupee(c.spend)}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-sm align-top">
        {c.cac === null ? <span className="text-ink-3">—</span> : rupee(c.cac)}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-sm align-top">
        {c.roas === null ? <span className="text-ink-3">—</span> : `${c.roas.toFixed(1)}×`}
      </td>
      <td className="px-3 py-2.5 align-top">
        <Badge kind={ACTION_TONE[rec.action] ?? "muted"} size="sm" title={rec.reason}>{rec.label}</Badge>
      </td>
    </tr>
  );
}

function ChannelTable({ channels, unattributed, unattributedShare }: {
  channels: ChannelStat[]; unattributed: ChannelStat[]; unattributedShare: number;
}) {
  const th = "px-3 py-2.5 text-2xs font-semibold text-ink-3 uppercase tracking-wider";
  return (
    <Card flush>
      <div className="px-4 pt-4 pb-2">
        <p className="text-sm font-semibold text-ink">Channel profitability</p>
        <p className="text-[12px] text-ink-3 mt-0.5">
          Ranked by won value. A dash means the figure is not computable from what is recorded — never a zero.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px]">
          <thead className="bg-paper-2 border-y border-hairline-strong">
            <tr>
              <th className={cn(th, "text-left")}>Channel</th>
              <th className={cn(th, "text-right")}>Leads</th>
              <th className={cn(th, "text-right")}>Won</th>
              <th className={cn(th, "text-right")}>Win rate</th>
              <th className={cn(th, "text-right")}>Won value</th>
              <th className={cn(th, "text-right")}>Spend</th>
              <th className={cn(th, "text-right")}>CAC</th>
              <th className={cn(th, "text-right")}>ROAS</th>
              <th className={cn(th, "text-left")}>Action</th>
            </tr>
          </thead>
          <tbody>
            {channels.length === 0 ? (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-sm text-ink-3">No attributable channels in this period.</td></tr>
            ) : channels.map((c) => <ChannelRow key={c.channel} c={c} />)}

            {unattributed.length > 0 && (
              <>
                <tr className="bg-paper-2/60 border-y border-hairline">
                  <td colSpan={9} className="px-3 py-2">
                    <p className="text-2xs font-semibold text-ink-2 uppercase tracking-wider">
                      Not marketing channels · {Math.round(unattributedShare * 100)}% of leads
                    </p>
                    {/* This is the most useful number on the page: the share of
                        pipeline whose origin nobody knows. Ranking these next to
                        real channels would imply "manual" as somewhere to invest. */}
                    <p className="text-xs text-ink-3 mt-0.5 max-w-[54rem]">
                      These record how a lead was typed in, not where it came from, so they carry no budget decision.
                      The size of this group is itself the finding — that share of the pipeline has no known origin.
                    </p>
                  </td>
                </tr>
                {unattributed.map((c) => <ChannelRow key={c.channel} c={c} />)}
              </>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── Funnel ──────────────────────────────────────────────────────────────────

function Funnel({ steps }: { steps: { key: string; label: string; count: number | null; available: boolean; conversion: number | null; benchmark: number | null; bottleneck: boolean; note: string | null }[] }) {
  const measured = steps.filter((s) => s.available);
  const widest = Math.max(1, ...measured.map((s) => s.count ?? 0));

  return (
    <Card className="p-4">
      <p className="text-sm font-semibold text-ink mb-1">Conversion funnel</p>
      {/* Stated because the last step counts PAYMENTS while the cards above count
          leads marked won, and the two legitimately differ. An unexplained
          mismatch between two numbers on one page destroys trust in both. */}
      <p className="text-xs text-ink-3 mb-3 max-w-[52rem] leading-snug">
        The last step counts payments received, not leads marked won — a payment can settle a deal closed in an
        earlier period, and one customer can pay more than once. That is why it may differ from the deal count in
        the cards above.
      </p>
      <ul className="space-y-2.5">
        {steps.map((s) => (
          <li key={s.key}>
            <div className="flex items-baseline justify-between gap-3 mb-1">
              <span className={cn("text-sm", s.available ? "text-ink" : "text-ink-3")}>{s.label}</span>
              <span className="flex items-center gap-2 shrink-0">
                {s.conversion !== null && (
                  <Badge kind={s.bottleneck ? "danger" : "success"} size="sm" dot
                         title={s.benchmark !== null ? `Target ${Math.round(s.benchmark * 100)}%` : undefined}>
                    {Math.round(s.conversion * 100)}%
                  </Badge>
                )}
                <span className={cn("font-serif text-lg tabular-nums", s.available ? "text-ink" : "text-ink-3")}>
                  {s.count === null ? "—" : s.count}
                </span>
              </span>
            </div>
            <div className="h-2 rounded-full bg-paper-2 overflow-hidden">
              {s.available && (
                <div className="h-full rounded-full bg-amber/70"
                     style={{ width: `${Math.max(2, ((s.count ?? 0) / widest) * 100)}%` }} />
              )}
            </div>
            {s.note && <p className="text-xs text-ink-3 mt-1 leading-snug">{s.note}</p>}
            {s.bottleneck && s.benchmark !== null && (
              <p className="text-xs text-rose mt-1">
                Below the {Math.round(s.benchmark * 100)}% target — this is the tightest point in the funnel.
              </p>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ── AI advisor ──────────────────────────────────────────────────────────────

/**
 * The brief asks Gemini to output budget-reallocation advice from spend-versus-
 * revenue history. That is deliberately NOT wired up yet, and the panel says so
 * rather than showing an empty box.
 *
 * Two reasons, in order of importance:
 *  1. There is one month of history and ₹4,000 of tagged spend. An LLM given that
 *     will still produce three confident bullet points, because that is what it
 *     is for — and they would be advice to move real budget, generated from
 *     nothing. Wrong AI advice about money is worse than no AI advice.
 *  2. GEMINI_API_KEY is absent, so the call would fall through to a stub and
 *     print invented text that looks identical to real analysis.
 */
function AiAdvisorPanel({ canAdvise }: { canAdvise: boolean }) {
  return (
    <Card className="p-4">
      <div className="flex items-start gap-2.5">
        <Icon name="sparkles" size={16} className="text-indigo-ink shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink mb-1">AI budget recommendations</p>
          {canAdvise ? (
            <p className="text-[13px] text-ink-2">
              Enough spend is now tracked to analyse. Connect <span className="font-mono text-xs">GEMINI_API_KEY</span> to
              turn this on.
            </p>
          ) : (
            <p className="text-[13px] text-ink-2 max-w-[52rem] leading-relaxed">
              Held back on purpose. Budget advice needs spend tagged to channels over at least a couple of months;
              right now the report cannot compute a trustworthy ROAS, and an assistant asked to advise anyway would
              still return three confident bullet points built on nothing. Tag your marketing expenses by channel,
              give it two months, and this becomes worth reading.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
