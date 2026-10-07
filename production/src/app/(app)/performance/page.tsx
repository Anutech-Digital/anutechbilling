/**
 * Team Performance — outcome-based scoreboard for performance bonuses.
 *
 * Ranks login teammates by REAL business results (revenue collected, deals won,
 * quotes, on-time tasks) for a chosen month. Enter a bonus pool and it splits by
 * score. No surveillance — every point is real work the app already recorded.
 * Owner/manager only (route-gated in nav).
 */
"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import { rupee } from "@/lib/utils";
import { usePerformance, PERF_WEIGHTS, type PerfRow, type PerfScope } from "@/lib/queries/performance";
import { KUDOS_PER_GIVER_PER_PERIOD } from "@/lib/performance/gamification";

function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function PerformancePage() {
  const [period, setPeriod] = React.useState(thisMonth());
  const [scope, setScope] = React.useState<PerfScope>("month");
  const [pool, setPool] = React.useState("");
  const { data: rows, isLoading } = usePerformance(period, scope);

  const scopeTabs: TabBarItem[] = [
    { id: "week",  label: "This week" },
    { id: "month", label: "Month" },
  ];

  const totalScore = (rows ?? []).reduce((s, r) => s + r.score, 0);
  const poolN = Math.max(0, Math.round(Number(pool) || 0));

  return (
    <div className="mx-auto max-w-[1100px] p-4 md:p-6 lg:p-8 space-y-6">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Payroll</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Performance</h1>
          <p className="text-sm text-ink-3 mt-1">
            Ranked by real results — revenue, deals, quotes, on-time tasks. Not screen-time.
          </p>
        </div>
        {/* The month picker only applies to the monthly board. A weekly board is
            always "this week" — a month holds four or five weeks, so there is no
            single sensible answer to "which week of August". Hiding it beats
            leaving a control that silently does nothing. */}
        {scope === "month" && (
          <div>
            <label htmlFor="performance-month" className="block text-2xs text-ink-3 mb-1">Month</label>
            <Input id="performance-month" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="w-44" />
          </div>
        )}
      </header>

      <TabBar items={scopeTabs} value={scope} onChange={(v) => setScope(v as PerfScope)} />

      {/* Bonus pool splitter */}
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label htmlFor="performance-bonus-pool" className="block text-2xs text-ink-3 mb-1">
              Bonus pool for {scope === "week" ? "this week" : "this month"} (₹)
            </label>
            <Input id="performance-bonus-pool" type="number" min={0} value={pool} onChange={(e) => setPool(e.target.value)} placeholder="e.g. 50000" className="w-48" />
          </div>
          <p className="text-[12px] text-ink-3 flex-1 min-w-[200px]">
            Enter a pool and it splits by each person's score below — a fair, transparent starting point (you decide the final call).
          </p>
        </div>
      </Card>

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
      ) : (rows?.length ?? 0) === 0 ? (
        <Card className="py-2">
          <EmptyState icon="users" title="No team members yet" body="Invite teammates at /team, then their results this month show up here." />
        </Card>
      ) : totalScore === 0 ? (
        <Card className="py-2">
          <EmptyState
            icon="chart"
            title={`No scored activity ${scope === "week" ? "this week" : "this month"}`}
            body="Deals won, payments collected, quotes and on-time tasks earn points. Once the team logs work in this period, the leaderboard fills in." />
        </Card>
      ) : (
        <div className="space-y-3">
          {(rows ?? []).map((r, i) => (
            <PerfCard key={r.userId} row={r} rank={i + 1} share={poolN > 0 && totalScore > 0 ? Math.round(poolN * r.score / totalScore) : null} />
          ))}
        </div>
      )}

      <p className="text-2xs text-ink-3">
        Weights: +1 pt / ₹{PERF_WEIGHTS.revenuePerRupees.toLocaleString("en-IN")} collected · deal won +{PERF_WEIGHTS.dealWon} ·
        quote +{PERF_WEIGHTS.quoteSent} · payment +{PERF_WEIGHTS.paymentRecorded} · task on-time +{PERF_WEIGHTS.taskOnTime} · late {PERF_WEIGHTS.taskLate} ·
        peer kudos +{PERF_WEIGHTS.kudosReceived} (max {KUDOS_PER_GIVER_PER_PERIOD} given per person per period).
      </p>
    </div>
  );
}

function PerfCard({ row, rank, share }: { row: PerfRow; rank: number; share: number | null }) {
  const [open, setOpen] = React.useState(false);
  const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `#${rank}`;
  return (
    <Card className="overflow-hidden">
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-3 p-4 text-left hover:bg-paper-2/40">
        <span className="w-8 text-center text-lg font-semibold">{medal}</span>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-ink">{row.name} <span className="text-2xs font-normal text-ink-3">· {row.role}</span></div>
          <div className="text-[12px] text-ink-3 mt-0.5">
            {rupee(row.revenue)} collected · {row.dealsWon} won · {row.quotesSent} quotes · {row.tasksOnTime} tasks on-time
            {(row.kudosReceived ?? 0) > 0 && <> · {row.kudosReceived} kudos</>}
          </div>
          {/* Badges render only when earned — a row of greyed-out "not yet"
              badges reads as a scolding, not an achievement. */}
          {(row.badges?.length ?? 0) > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
              {row.badges?.map((b) => (
                <Badge key={b.id} kind="success" size="sm" title={b.criterion}>
                  {b.emoji} {b.label}
                </Badge>
              ))}
            </div>
          )}
        </div>
        <div className="text-right">
          <div className="font-serif text-2xl text-ink tabular-nums">{row.score}</div>
          <div className="text-3xs uppercase tracking-wider text-ink-3">points</div>
        </div>
        {share !== null && (
          <div className="text-right pl-3 ml-1 border-l border-hairline">
            <div className="font-serif text-xl text-emerald tabular-nums">{rupee(share)}</div>
            <div className="text-3xs uppercase tracking-wider text-ink-3">bonus</div>
          </div>
        )}
      </button>
      {open && (
        <div className="border-t border-hairline px-4 py-3 bg-paper-2/30">
          <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-2">How the {row.score} points break down</div>
          <ul className="space-y-1">
            {row.breakdown.map((b) => (
              <li key={b.label} className="flex items-center justify-between text-[13px]">
                <span className="text-ink-2">{b.label} <span className="text-ink-3">({b.detail})</span></span>
                <span className={`font-mono tabular-nums ${b.points < 0 ? "text-rose" : "text-ink"}`}>{b.points > 0 ? "+" : ""}{b.points}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
