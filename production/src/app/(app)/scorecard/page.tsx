/**
 * Scorecards — per-employee, role-aware view of performance (owner/manager).
 *
 * Three honest lenses: OUTCOMES (money/results — the real score, role-weighted),
 * RELIABILITY (attendance + on-time tasks), and ACTIVITY (a leading signal from
 * the activity log — NOT the score, just "how busy in the app"). Outcome-first
 * by design: activity volume is never the measure of performance.
 */
"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { rupee, cn } from "@/lib/utils";
import { usePerformance, roleFocus, type PerfRow } from "@/lib/queries/performance";

function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function ScorecardPage() {
  const [period, setPeriod] = React.useState(thisMonth());
  const { data: rows, isLoading } = usePerformance(period);

  return (
    <div className="mx-auto max-w-[1000px] p-4 md:p-6 lg:p-8 space-y-5">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Payroll</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Scorecards</h1>
          <p className="text-sm text-ink-3 mt-1">
            Har employee — <b>result pehle</b> (role ke hisaab se), phir reliability, phir activity. Activity sirf signal hai, score nahi.
          </p>
        </div>
        <div>
          <label className="block text-[11px] text-ink-3 mb-1">Month</label>
          <Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="w-44" />
        </div>
      </header>

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-40 w-full" />)}</div>
      ) : (rows?.length ?? 0) === 0 ? (
        <Card className="py-2"><EmptyState icon="users" title="No team members yet" body="Invite teammates at /team — phir unki scorecard yahan aayegi." /></Card>
      ) : (
        <div className="space-y-4">
          {(rows ?? []).map((r) => <Scorecard key={r.userId} row={r} />)}
        </div>
      )}

      <p className="text-[11px] text-ink-3">
        Score = real outcomes (revenue, deals, quotes, payments, on-time tasks). Attendance + activity dikhaye jaate hain par score me nahi ginte — taaki koi "number game" na khele.
      </p>
    </div>
  );
}

function Metric({ label, value, tone, focus }: { label: string; value: string; tone?: string; focus?: boolean }) {
  return (
    <div className={cn("rounded-lg border p-3", focus ? "border-amber/40 bg-amber-soft/25" : "border-hairline")}>
      <div className="text-[10px] uppercase tracking-wider text-ink-3">{label}{focus ? " ★" : ""}</div>
      <div className={cn("font-serif text-xl mt-0.5 tabular-nums", tone ?? "text-ink")}>{value}</div>
    </div>
  );
}

function Scorecard({ row }: { row: PerfRow }) {
  const focus = roleFocus(row.role);
  const isSales = row.role === "sales" || row.role === "sales_senior";
  const isAcct = row.role === "accountant";
  const isSupport = row.role === "support";
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <div className="font-semibold text-ink text-lg">{row.name}</div>
          <div className="text-[12px] text-ink-3">{row.role} · focus: <b className="text-ink-2">{focus.label}</b> <span className="text-ink-3">({focus.hint})</span></div>
        </div>
        <div className="text-right shrink-0">
          <div className="font-serif text-3xl text-ink tabular-nums leading-none">{row.score}</div>
          <div className="text-[10px] uppercase tracking-wider text-ink-3 mt-1">score</div>
        </div>
      </div>

      <div className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold mb-2">Outcomes — the real score</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <Metric label="Revenue" value={rupee(row.revenue, { compact: true })} tone="text-emerald" focus={isSales || isAcct} />
        <Metric label="Deals won" value={String(row.dealsWon)} focus={isSales} />
        <Metric label="Quotes" value={String(row.quotesSent)} focus={isSales} />
        <Metric label="Payments" value={String(row.paymentsCount)} focus={isAcct} />
      </div>

      <div className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold mt-4 mb-2">Reliability</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
        <Metric label="Present days" value={String(row.presentDays)} tone="text-indigo" />
        <Metric label="Tasks on-time" value={String(row.tasksOnTime)} focus={isSupport} />
        <Metric label="Tasks late" value={String(row.tasksLate)} tone={row.tasksLate > 0 ? "text-rose" : "text-ink"} />
      </div>

      <div className="mt-4 flex items-center gap-2 text-[12px] text-ink-3">
        <Icon name="clock" size={13} />
        <span>Activity (leading signal, score me nahi): <b className="text-ink-2">{row.activityCount}</b> actions app me is mahine</span>
      </div>
    </Card>
  );
}
