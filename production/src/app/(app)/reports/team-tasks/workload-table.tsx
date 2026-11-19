/**
 * R-2932 — the two tables of Reports → Team tasks: workload per person, and the 8-week
 * numbers behind the trend chart. Presentational (rows from team-tasks.ts).
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TrendWeek, WorkloadRow } from "./team-tasks";

const th = "p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider";
const num = "p-3 text-right tabular-nums";

/** The Tasks list filtered to one person (and, optionally, one tab). */
export function tasksHref(memberId: string, tab?: "overdue" | "done"): string {
  return `/tasks?assignee=${encodeURIComponent(memberId)}${tab ? `&tab=${tab}` : ""}`;
}

export function WorkloadTable({ rows }: { rows: readonly WorkloadRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="team-workload">
        <thead className="bg-paper-2 border-b border-hairline">
          <tr>
            <th scope="col" className={cn(th, "text-left")}>Team member</th>
            <th scope="col" className={cn(th, "text-right")}>Open</th>
            <th scope="col" className={cn(th, "text-right")}>Overdue</th>
            <th scope="col" className={cn(th, "text-right")}>Done this week</th>
            <th scope="col" className={cn(th, "text-right")}><span className="sr-only">Open their tasks</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {rows.map((r) => (
            <tr key={r.id ?? "unassigned"} data-testid={`workload-${r.id ?? "unassigned"}`}>
              <th scope="row" className="p-3 text-left font-medium text-ink">
                {r.id ? (
                  <Link href={tasksHref(r.id) as Route} className="underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded-sm">
                    {r.name}
                  </Link>
                ) : (
                  <span className="text-ink-2" title="Tasks with no owner, or whose owner is no longer in the team">{r.name}</span>
                )}
              </th>
              <td className={num} data-col="open">{r.open}</td>
              <td className={cn(num, r.overdue > 0 && "font-semibold text-rose")} data-col="overdue">
                {r.id && r.overdue > 0 ? (
                  <Link href={tasksHref(r.id, "overdue") as Route} className="underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded-sm" aria-label={`${r.overdue} overdue — open ${r.name}'s overdue tasks`}>
                    {r.overdue}
                  </Link>
                ) : r.overdue}
              </td>
              <td className={num} data-col="done">{r.doneThisWeek}</td>
              <td className="p-3 text-right">
                {r.id && (
                  <Button asChild size="sm" iconRight="chevron_right">
                    <Link href={tasksHref(r.id) as Route} aria-label={`View ${r.name}'s tasks`}>View tasks</Link>
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The chart's numbers as a table — for screen readers, print, and anyone who wants the figures. */
export function TrendTable({ weeks }: { weeks: readonly TrendWeek[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs" data-testid="team-trend-table">
        <caption className="sr-only">Tasks completed and late, per week, last {weeks.length} weeks</caption>
        <thead>
          <tr className="border-b border-hairline text-ink-3">
            <th scope="col" className="py-1.5 pr-3 text-left font-semibold">Week of</th>
            {weeks.map((w) => <th key={w.start} scope="col" className="py-1.5 px-2 text-right font-medium whitespace-nowrap">{w.label}</th>)}
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-hairline">
            <th scope="row" className="py-1.5 pr-3 text-left font-medium text-ink-2">Completed</th>
            {weeks.map((w) => <td key={w.start} className="py-1.5 px-2 text-right tabular-nums">{w.completed}</td>)}
          </tr>
          <tr>
            <th scope="row" className="py-1.5 pr-3 text-left font-medium text-ink-2">Late</th>
            {weeks.map((w) => <td key={w.start} className={cn("py-1.5 px-2 text-right tabular-nums", w.late > 0 && "text-rose font-semibold")}>{w.late}</td>)}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
