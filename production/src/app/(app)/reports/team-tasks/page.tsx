/**
 * Reports → Team tasks (R-2932, 18 Nov 2026) — one page for the owner: who has how much
 * work, who is behind, and whether the team is catching up.
 *
 *   • Per person: Open / Overdue / Done this week (Mon → today, IST). Furthest behind first.
 *     A name (or "View tasks") opens the Tasks list filtered to that person.
 *   • Last 8 weeks: tasks completed vs tasks late (due that week and missed or ticked late).
 *
 * Read-only, counted from the tasks table (team-tasks.ts) — nothing is typed in here.
 */
"use client";

import * as React from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadError } from "@/components/shared/load-error";
import { StatStrip } from "@/components/shared/stat-strip";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useTeamMembers } from "@/lib/queries/team";
import { teamWorkload, weeklyTrend, TREND_WEEKS } from "./team-tasks";
import { useTeamTasks } from "./team-tasks-data";
import { TrendTable, WorkloadTable } from "./workload-table";

const COMPLETED = "hsl(var(--emerald))";
const LATE = "hsl(var(--rose))";
const AXIS = { fontSize: 11, fill: "var(--color-ink-3, #71717a)" };

export default function TeamTasksReportPage() {
  const { data: me, isLoading: meLoading } = useCurrentUser();
  const tasksQ = useTeamTasks(me?.tenantId);
  const membersQ = useTeamMembers();

  const { rows, trend } = React.useMemo(() => {
    const now = new Date();
    const tasks = tasksQ.data ?? [];
    return { rows: teamWorkload(tasks, membersQ.data ?? [], now), trend: weeklyTrend(tasks, now) };
  }, [tasksQ.data, membersQ.data]);

  const total = rows.reduce(
    (s, r) => ({ open: s.open + r.open, overdue: s.overdue + r.overdue, done: s.done + r.doneThisWeek }),
    { open: 0, overdue: 0, done: 0 },
  );
  const anyTrend = trend.some((w) => w.completed > 0 || w.late > 0);

  const isLoading = meLoading || membersQ.isLoading || (!!me?.tenantId && tasksQ.isLoading);
  const failed = tasksQ.isError ? tasksQ : membersQ.isError ? membersQ : null;

  return (
    <div className="mx-auto max-w-[1100px] p-4 md:p-6 lg:p-8 space-y-5">
      <header>
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Reports</p>
        <h1 className="font-serif text-3xl md:text-4xl leading-tight">Team tasks</h1>
        <p className="text-sm text-ink-3 mt-1">Who has how much work, who is behind, and the last {TREND_WEEKS} weeks.</p>
      </header>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : failed ? (
        <LoadError what="The team tasks report" error={failed.error} onRetry={() => void failed.refetch()} />
      ) : rows.length === 0 ? (
        <Card className="py-2">
          <EmptyState icon="users" title="No team members yet" body="Invite teammates at Team, then their tasks show up here." />
        </Card>
      ) : (
        <>
          <StatStrip
            items={[
              { label: "Open", value: total.open },
              { label: "Overdue", value: total.overdue, tone: total.overdue > 0 ? "rose" : "default" },
              { label: "Done this week", value: total.done, tone: "emerald" },
            ]}
          />

          <Card className="overflow-hidden">
            <div className="px-5 pt-4 pb-3">
              <h2 className="text-sm font-semibold text-ink leading-tight">Workload by person</h2>
              <p className="text-xs text-ink-3 mt-0.5">Most overdue first. Week = Monday to today.</p>
            </div>
            <WorkloadTable rows={rows} />
          </Card>

          <Card className="p-5" data-testid="team-trend">
            <h2 className="text-sm font-semibold text-ink leading-tight">Completed vs late — last {TREND_WEEKS} weeks</h2>
            <p className="text-xs text-ink-3 mt-0.5 mb-4">
              Completed = ticked done in that week. Late = due in that week and still open, or ticked after its due time.
            </p>
            {anyTrend ? (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={trend} margin={{ left: 0, right: 8, top: 4, bottom: 0 }} barGap={2}>
                  <CartesianGrid strokeDasharray="2 4" stroke="var(--color-hairline, #e4e4e7)" vertical={false} />
                  <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} />
                  <YAxis tick={AXIS} axisLine={false} tickLine={false} width={32} allowDecimals={false} />
                  <Tooltip cursor={{ fill: "var(--color-hairline, #e4e4e7)", opacity: 0.4 }} />
                  <Legend iconType="square" wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="completed" name="Completed" fill={COMPLETED} radius={[3, 3, 0, 0]} />
                  <Bar dataKey="late" name="Late" fill={LATE} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="py-8 text-center text-sm text-ink-3">No tasks were completed or late in the last {TREND_WEEKS} weeks.</p>
            )}
            <div className="mt-4">
              <TrendTable weeks={trend} />
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
