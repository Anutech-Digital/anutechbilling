/**
 * Tasks → Overview (R-2936, 19 Nov 2026) — the Tasks list at a glance, before the list itself:
 *
 *   • four cards: Open / Overdue / Due today / Done this week;
 *   • two donuts over the OPEN tasks: by status (Not started / In progress / On hold, R-2927)
 *     and by priority (High / Medium / Low, R-2926);
 *   • a "Due" strip: Overdue / Today / This week / This month;
 *   • Upcoming 5 and Newly added 5.
 *
 * Read-only. It reads the same rows as the Tasks list (useTaskList — one shared cache), and
 * counts them with the list's own groups (overview-counts.ts), so a number here equals the tab
 * it opens. Every card, strip tile and donut line is a link to /tasks on the closest tab
 * (`?tab=`); a task name opens that task (`?task=`). Overdue and Today open exactly their
 * tasks. The Tasks list has no status / priority / due-range filter in its URL yet (R-2938) —
 * until then Open and the donut lines open the All tab, This week / This month the Upcoming tab.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useTaskList, type TaskWithLink } from "@/lib/queries/tasks";
import { AddTaskDialog } from "@/components/features/tasks/add-task-dialog";
import { taskLeadName } from "@/components/features/tasks/task-row";
import { istWeekBounds, taskSummary } from "@/components/features/tasks/task-overview";
import { TASK_PRIORITY_META, priorityOf, showsPriorityBadge } from "@/components/features/tasks/task-priority";
import { KPI } from "@/components/shared/kpi";
import { LoadError } from "@/components/shared/load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FAB } from "@/components/ui/fab";
import { Skeleton } from "@/components/ui/skeleton";
import { addDaysISO, formatIstDate, formatIstTime, istDayStartUtc, toIstDate } from "@/lib/dates/ist";
import { cn } from "@/lib/utils";
import {
  dueStrip, newlyAddedTasks, prioritySlices, statusSlices, taskHref, tasksTabHref, upcomingTasks, OVERVIEW_LIST_SIZE,
} from "./overview-counts";
import { OverviewDonut, type DonutSlice } from "./overview-donut";

/* Design tokens (globals.css) — they follow light / dark mode by themselves. */
const STATUS_COLOR = { not_started: "hsl(var(--ink-3))", in_progress: "hsl(var(--indigo))", on_hold: "hsl(var(--amber))" } as const;
const PRIORITY_COLOR = { high: "hsl(var(--rose))", medium: "hsl(var(--amber))", low: "hsl(var(--ink-3))" } as const;

/** "19 Nov" — the year only adds noise on a date a few days away. */
const shortDate = (day: string) => formatIstDate(day).replace(/ \d{4}$/, "");

export default function TasksOverviewPage() {
  /* Re-read "now" once a minute: a task turns Overdue the minute its time passes (R-471). */
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const { data: me, isLoading: meLoading } = useCurrentUser();
  const list = useTaskList(me?.tenantId);
  const tasks = React.useMemo(() => list.data ?? [], [list.data]);

  const summary = React.useMemo(() => taskSummary(tasks, now), [tasks, now]);
  const strip = React.useMemo(() => dueStrip(tasks, now), [tasks, now]);
  const upcoming = React.useMemo(() => upcomingTasks(tasks, now), [tasks, now]);
  const newest = React.useMemo(() => newlyAddedTasks(tasks, OVERVIEW_LIST_SIZE, now), [tasks, now]);
  const allOpen = tasksTabHref("all");
  const byStatus: DonutSlice[] = React.useMemo(
    () => statusSlices(tasks, now).map((s) => ({ ...s, color: STATUS_COLOR[s.id], href: allOpen })),
    [tasks, now, allOpen],
  );
  const byPriority: DonutSlice[] = React.useMemo(
    () => prioritySlices(tasks, now).map((s) => ({ ...s, color: PRIORITY_COLOR[s.id], href: allOpen })),
    [tasks, now, allOpen],
  );

  /* "Done this week" — the list holds only the 100 newest completed tasks, so the number is
     counted on the server: the same read (and cache key) as the Tasks page's Summary strip. */
  const week = istWeekBounds(now);
  const doneWeek = useQuery({
    queryKey: ["tasks", "done-this-week", me?.tenantId, week.start, "all"],
    enabled: !!me?.tenantId,
    queryFn: async (): Promise<number> => {
      const { count, error } = await createClient().from("tasks").select("id", { count: "exact", head: true })
        .eq("tenant_id", me!.tenantId).eq("status", "done")
        .gte("completed_at", istDayStartUtc(week.start).toISOString())
        .lt("completed_at", istDayStartUtc(addDaysISO(week.end, 1)).toISOString());
      if (error) throw error;
      return count ?? 0;
    },
  });
  const doneThisWeek = doneWeek.data ?? summary.doneThisWeek;

  const [addOpen, setAddOpen] = React.useState(false);
  const isLoading = meLoading || (!!me?.tenantId && list.isLoading);
  const today = toIstDate(now);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1100px] mx-auto space-y-5">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Sales</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Tasks overview</h1>
          <p className="text-sm text-ink-3 mt-1">
            How much is open, what is late and what comes next. Press a number to open the Tasks list on that tab.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
            Add task
          </Button>
        </div>
      </div>

      {list.error ? (
        /* A failed read shows no numbers: "0 overdue" above an error would be a false all-clear. */
        <LoadError what="The tasks overview" error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid="overview-cards">
            <KPI label="Open" value={summary.open} loading={isLoading} icon="clock" href={tasksTabHref("all")} />
            <KPI label="Overdue" value={summary.overdue} loading={isLoading} icon="alert" accent={summary.overdue > 0 ? "rose" : "ink"} href={tasksTabHref("overdue")} />
            <KPI label="Due today" value={summary.today} loading={isLoading} icon="calendar" accent={summary.today > 0 ? "amber" : "ink"} href={tasksTabHref("today")} />
            <KPI label="Done this week" value={doneThisWeek} loading={isLoading || doneWeek.isLoading} icon="check" accent="emerald" href={tasksTabHref("done")} />
          </div>

          {isLoading ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <Skeleton className="h-56 w-full" />
              <Skeleton className="h-56 w-full" />
            </div>
          ) : (
            <>
              <div className="grid gap-4 lg:grid-cols-2">
                <OverviewDonut
                  testId="overview-status"
                  title="Open tasks by status"
                  hint="The step set on each task. Done tasks are not counted here."
                  slices={byStatus}
                />
                <OverviewDonut
                  testId="overview-priority"
                  title="Open tasks by priority"
                  hint="A task with no priority set counts as Medium."
                  slices={byPriority}
                />
              </div>

              <Card className="p-5" data-testid="overview-due">
                <h2 className="text-sm font-semibold text-ink leading-tight">Open tasks by due date</h2>
                <p className="text-xs text-ink-3 mt-0.5 mb-3">
                  This week and This month count what is still ahead — today&apos;s tasks included, overdue ones not.
                </p>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <DueTile label="Overdue" value={strip.overdue} note="Due time has passed" tone={strip.overdue > 0 ? "rose" : "default"} href={tasksTabHref("overdue")} />
                  <DueTile label="Today" value={strip.today} note={`Still due today, ${shortDate(today)}`} tone={strip.today > 0 ? "amber" : "default"} href={tasksTabHref("today")} />
                  <DueTile label="This week" value={strip.thisWeek} note={`Still ahead, by Sun ${shortDate(strip.weekEnd)}`} href={tasksTabHref("upcoming")} />
                  <DueTile label="This month" value={strip.thisMonth} note={`Still ahead, by ${shortDate(strip.monthEnd)}`} href={tasksTabHref("upcoming")} />
                </div>
              </Card>

              <div className="grid gap-4 lg:grid-cols-2">
                <TaskShortList
                  testId="overview-upcoming"
                  title="Upcoming"
                  hint={`The next ${OVERVIEW_LIST_SIZE} open tasks, soonest first.`}
                  tasks={upcoming}
                  empty="Nothing is scheduled ahead."
                  seeAll={{ href: tasksTabHref("upcoming"), label: "All upcoming tasks" }}
                  when={(t) => (t.due_at ? dueWords(t.due_at, today) : "")}
                />
                <TaskShortList
                  testId="overview-new"
                  title="Newly added"
                  hint={`The ${OVERVIEW_LIST_SIZE} newest open tasks.`}
                  tasks={newest}
                  empty="No open tasks yet."
                  seeAll={{ href: tasksTabHref("all"), label: "All tasks" }}
                  when={(t) => `Added ${shortDate(toIstDate(t.created_at))}`}
                />
              </div>
            </>
          )}
        </>
      )}

      <AddTaskDialog open={addOpen} onOpenChange={setAddOpen} linkTo={null} />
      {/* Mobile primary — the header button scrolls away (same as the Tasks list). */}
      <FAB icon="plus" label="Add task" onClick={() => setAddOpen(true)} />
    </div>
  );
}

/** "Today, 03:30 pm" / "20 Nov, 11:00 am". */
function dueWords(dueAt: string, today: string): string {
  const day = toIstDate(dueAt);
  return `${day === today ? "Today" : shortDate(day)}, ${formatIstTime(dueAt)}`;
}

// ─── One tile of the Due strip — the whole tile is the link ─────────────────
function DueTile({ label, value, note, tone = "default", href }: {
  label: string; value: number; note: string; tone?: "default" | "rose" | "amber"; href: string;
}) {
  return (
    <Link
      href={href as Route}
      aria-label={`${label}: ${value} open ${value === 1 ? "task" : "tasks"}. ${note}. Open the Tasks list`}
      className="block rounded-md border border-hairline px-3 py-2.5 transition-colors hover:bg-paper-2 hover:border-hairline-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
    >
      <span className="block text-2xs uppercase tracking-wide font-medium text-ink-3">{label}</span>
      <span className={cn(
        "block font-serif text-2xl tabular-nums leading-tight",
        tone === "rose" ? "text-rose" : tone === "amber" ? "text-amber-ink" : "text-ink",
      )}>
        {value}
      </span>
      <span className="block text-xs text-ink-3">{note}</span>
    </Link>
  );
}

// ─── Upcoming / Newly added — five one-line tasks, each opens in the Tasks list ──
function TaskShortList({ title, hint, tasks, empty, seeAll, when, testId }: {
  title: string;
  hint: string;
  tasks: readonly TaskWithLink[];
  empty: string;
  seeAll: { href: string; label: string };
  when: (t: TaskWithLink) => string;
  testId: string;
}) {
  return (
    <Card className="overflow-hidden" data-testid={testId}>
      <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3">
        <div>
          <h2 className="text-sm font-semibold text-ink leading-tight">{title}</h2>
          <p className="text-xs text-ink-3 mt-0.5">{hint}</p>
        </div>
        <Link
          href={seeAll.href as Route}
          className="-my-2 shrink-0 rounded py-2 text-xs font-medium text-amber-ink underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
        >
          {seeAll.label}
        </Link>
      </div>
      {tasks.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-ink-3">{empty}</p>
      ) : (
        <ul className="divide-y divide-hairline border-t border-hairline">
          {tasks.map((t) => {
            const about = taskLeadName(t) ?? t.customers?.name ?? t.quotes?.customer_name ?? null;
            const priority = priorityOf(t);
            return (
              <li key={t.id}>
                <Link
                  href={taskHref(t.id) as Route}
                  className="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink" title={t.title}>{t.title}</span>
                    {about && <span className="block truncate text-xs text-ink-3">{about}</span>}
                  </span>
                  {showsPriorityBadge(priority) && (
                    <Badge kind={TASK_PRIORITY_META[priority].badge}>{TASK_PRIORITY_META[priority].label}</Badge>
                  )}
                  <span className="shrink-0 text-xs tabular-nums text-ink-2">{when(t)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
