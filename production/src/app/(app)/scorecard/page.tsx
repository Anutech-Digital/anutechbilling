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
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadError } from "@/components/shared/load-error";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { usePerformance, roleFocus, type PerfRow } from "@/lib/queries/performance";
import { scorePeriodNow } from "@/lib/performance/employee-score";
import { KPI_LABEL, type KpiKey } from "@/lib/performance/kpi-records";
import { KpiRecordsSheet, kpiDisplay } from "./kpi-records-sheet";

/** R-2965: which tile is open — one Sheet for the page. */
type OpenKpi = { userId: string; kpi: KpiKey } | null;

export default function ScorecardPage() {
  /* useSearchParams needs a boundary (R-2725: ?user=<login> opens one person's scorecard). */
  return <React.Suspense fallback={null}><Scorecards /></React.Suspense>;
}

function Scorecards() {
  /* R-2725: the IST month — the same one the Employees table's Score column reads. */
  const [period, setPeriod] = React.useState(scorePeriodNow());
  const perf = usePerformance(period, "month", { detail: true });
  const { data: all, isLoading } = perf;
  /* R-2725: opened from an employee (Score column / profile button) → that person only. */
  const onlyUser = useSearchParams().get("user");
  const rows = onlyUser ? (all ?? []).filter((r) => r.userId === onlyUser) : all;
  /* R-2965: a tile opens the records behind its number. The Sheet reads the row from the same
     query result, so a refetch keeps the open list and the tile in step. */
  const [openKpi, setOpenKpi] = React.useState<OpenKpi>(null);
  const openRow = openKpi ? (all ?? []).find((r) => r.userId === openKpi.userId) ?? null : null;
  const onOpenKpi = React.useCallback((userId: string, kpi: KpiKey) => setOpenKpi({ userId, kpi }), []);

  return (
    <div className="mx-auto max-w-[1000px] p-4 md:p-6 lg:p-8 space-y-5">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Payroll</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Scorecards</h1>
          <p className="text-sm text-ink-3 mt-1">
            Every employee — <b>results first</b> (based on their role), then reliability, then activity. Activity is only a signal, not part of the score.
          </p>
        </div>
        <div className="flex items-end gap-2">
          {onlyUser && <Button asChild variant="outline"><Link href="/scorecard">All scorecards</Link></Button>}
          <div>
            <label htmlFor="scorecard-month" className="block text-2xs text-ink-3 mb-1">Month</label>
            <Input id="scorecard-month" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="w-44" />
          </div>
        </div>
      </header>

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-40 w-full" />)}</div>
      ) : perf.isError ? (
        /* R-1807: a failed read is an error + Try again — not "No team members yet", and
           never a Revenue of ₹0 for everyone. */
        <LoadError what="Scorecards" error={perf.error} onRetry={perf.refetch} />
      ) : onlyUser && (rows?.length ?? 0) === 0 ? (
        <Card className="py-2"><EmptyState icon="users" title="No scorecard for this person" body="They have no active login on your team. Open All scorecards to see everyone." /></Card>
      ) : (rows?.length ?? 0) === 0 ? (
        <Card className="py-2"><EmptyState icon="users" title="No team members yet" body="Invite teammates at /team — their scorecards will show here." /></Card>
      ) : (
        <div className="space-y-4">
          {(rows ?? []).map((r) => <Scorecard key={r.userId} row={r} onOpen={onOpenKpi} />)}
        </div>
      )}

      <KpiRecordsSheet
        row={openRow}
        kpi={openRow ? openKpi?.kpi ?? null : null}
        period={period}
        onOpenChange={(o) => { if (!o) setOpenKpi(null); }}
      />

      <p className="text-2xs text-ink-3">
        Click any number to see the records behind it. Score = real outcomes (revenue, deals, quotes, payments, on-time tasks). Attendance + activity are shown but not counted in the score — so nobody can play a "number game".
      </p>
    </div>
  );
}

/** R-2965: a KPI tile is a button — it opens the records behind its number. */
function Metric({ row, kpi, tone, focus, onOpen }: {
  row: PerfRow; kpi: KpiKey; tone?: string; focus?: boolean; onOpen: (userId: string, kpi: KpiKey) => void;
}) {
  const label = KPI_LABEL[kpi];
  const value = kpiDisplay(row, kpi);
  return (
    <button
      type="button"
      onClick={() => onOpen(row.userId, kpi)}
      aria-label={`${label} ${value} — show the records`}
      data-testid={`kpi-${kpi}-${row.userId}`}
      className={cn(
        "group rounded-lg border p-3 text-left transition-colors hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2 focus-visible:ring-offset-paper",
        focus ? "border-amber/40 bg-amber-soft/25" : "border-hairline",
      )}
    >
      <div className="text-3xs uppercase tracking-wider text-ink-3">{label}{focus ? " ★" : ""}</div>
      <div className={cn("font-serif text-xl mt-0.5 tabular-nums group-hover:underline underline-offset-4", tone ?? "text-ink")}>{value}</div>
    </button>
  );
}

function Scorecard({ row, onOpen }: { row: PerfRow; onOpen: (userId: string, kpi: KpiKey) => void }) {
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
          <div data-testid={`scorecard-score-${row.userId}`} className="font-serif text-3xl text-ink tabular-nums leading-none">{row.score}</div>
          <div className="text-3xs uppercase tracking-wider text-ink-3 mt-1">score</div>
        </div>
      </div>

      <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-2">Outcomes — the real score</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <Metric row={row} kpi="revenue" onOpen={onOpen} tone="text-emerald" focus={isSales || isAcct} />
        <Metric row={row} kpi="dealsWon" onOpen={onOpen} focus={isSales} />
        <Metric row={row} kpi="quotes" onOpen={onOpen} focus={isSales} />
        <Metric row={row} kpi="payments" onOpen={onOpen} focus={isAcct} />
      </div>

      <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mt-4 mb-2">Reliability</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
        <Metric row={row} kpi="present" onOpen={onOpen} tone="text-indigo" />
        <Metric row={row} kpi="tasksOnTime" onOpen={onOpen} focus={isSupport} />
        <Metric row={row} kpi="tasksLate" onOpen={onOpen} tone={row.tasksLate > 0 ? "text-rose" : "text-ink"} />
      </div>

      <div className="mt-4 flex items-center gap-2 text-[12px] text-ink-3">
        <Icon name="clock" size={13} />
        <span>Activity (leading signal, not scored):</span>
        <button
          type="button"
          onClick={() => onOpen(row.userId, "activity")}
          aria-label={`Activity ${kpiDisplay(row, "activity")} actions — show the records`}
          data-testid={`kpi-activity-${row.userId}`}
          className="rounded px-1 font-semibold text-ink-2 underline underline-offset-4 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
        >
          {kpiDisplay(row, "activity")}
        </button>
        <span>actions in the app this month</span>
      </div>
    </Card>
  );
}
