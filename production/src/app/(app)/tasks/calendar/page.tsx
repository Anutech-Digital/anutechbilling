/**
 * Task calendar (R-2931, 18 Nov 2026) — the month at a glance: every task on its due day
 * (IST), coloured like the Tasks list (Overdue / Today / Upcoming / Done). Press a day to see
 * that day's tasks below — the same rows as /tasks (done, snooze, edit, call). Drag an open
 * task to another day to change its due date; the clock time stays.
 *
 * Month and picked day live in the URL (`?month=2026-11&day=2026-11-18`), so Back and a
 * shared link come home to the same view.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { useUrlState } from "@/lib/hooks/use-url-state";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useUpdateTask, type TaskWithLink } from "@/lib/queries/tasks";
import { useTeamMembers } from "@/lib/queries/team";
import { AddTaskDialog } from "@/components/features/tasks/add-task-dialog";
import { TaskRow, taskLeadName } from "@/components/features/tasks/task-row";
import { TASKS_PAGE_WIDTH } from "@/components/features/tasks/tasks-tabs";
import { Card } from "@/components/ui/card";
import { Button, IconButton } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadError } from "@/components/shared/load-error";
import { cn } from "@/lib/utils";
import { formatIstDate, formatMonthLabel, istMonth, toIstDate } from "@/lib/dates/ist";
import { isMonth, moveDueToDay, shiftMonth, tasksByDay } from "./calendar-grid";
import { useCalendarTasks } from "./calendar-tasks";
import { MonthGrid, TONE_DOT, TONE_LABEL, TONE_ORDER } from "./month-grid";

const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const weekdayOf = (day: string) => WEEKDAY_LONG[new Date(`${day}T00:00:00Z`).getUTCDay()];

export default function TaskCalendarPage() {
  /* Re-read "now" once a minute: a task turns Overdue the minute its time passes (R-471). */
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const today = toIstDate(now);
  const thisMonth = istMonth(now);

  const [monthParam, setMonthParam] = useUrlState("month", "");
  const [dayParam, setDayParam] = useUrlState("day", "");
  const month = isMonth(monthParam) ? monthParam : thisMonth;
  /* The picked day: the URL's, else today while this month is showing. */
  const selectedDay = /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : month === thisMonth ? today : null;

  const goToMonth = (next: string) => {
    setMonthParam(next === thisMonth ? "" : next);
    setDayParam("");
  };

  const { data: me, isLoading: meLoading } = useCurrentUser();
  const list = useCalendarTasks(me?.tenantId, month);
  const { data: members = [] } = useTeamMembers();
  const memberById = React.useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const tasks = React.useMemo(() => list.data ?? [], [list.data]);
  const byDay = React.useMemo(() => tasksByDay(tasks), [tasks]);
  const dayTasks = selectedDay ? byDay.get(selectedDay) ?? [] : [];

  const updateTask = useUpdateTask();
  const moveTask = (taskId: string, day: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.status === "done") return;
    const due_at = moveDueToDay(task.due_at, day);
    if (!due_at) return;
    updateTask.mutate(
      { id: taskId, patch: { due_at } },
      { onSuccess: () => toast.success(`Due date moved to ${formatIstDate(day)}`, { description: task.title }) },
    );
  };

  const [addOpen, setAddOpen] = React.useState(false);
  const [editingTask, setEditingTask] = React.useState<TaskWithLink | null>(null);
  const isLoading = meLoading || (!!me?.tenantId && list.isLoading);

  return (
    /* R-2942: the Tasks section's one width (tasks-tabs.tsx). */
    <div className={cn(TASKS_PAGE_WIDTH, "p-4 md:p-6 lg:p-8")}>
      <div className="flex items-end justify-between gap-3 flex-wrap mb-4">
        <div>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Task calendar</h1>
          <p className="text-sm text-ink-3 mt-1">
            Every task on its due date. Press a day to see its tasks; drag a task to another day to move it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
            Add task
          </Button>
        </div>
      </div>

      {/* Month switcher + colour key */}
      <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-1">
          <IconButton icon="chevron_left" aria-label="Previous month" onClick={() => goToMonth(shiftMonth(month, -1))} />
          <h2 className="min-w-[150px] text-center text-base font-semibold tabular-nums" aria-live="polite">
            {formatMonthLabel(month, { month: "long" })}
          </h2>
          <IconButton icon="chevron_right" aria-label="Next month" onClick={() => goToMonth(shiftMonth(month, 1))} />
          <Button size="sm" className="ml-1" onClick={() => goToMonth(thisMonth)} disabled={month === thisMonth && selectedDay === today}>
            Today
          </Button>
        </div>
        <ul className="flex items-center gap-3 text-xs text-ink-2" aria-label="Colour key">
          {TONE_ORDER.map((tone) => (
            <li key={tone} className="inline-flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${TONE_DOT[tone]}`} aria-hidden="true" />
              {TONE_LABEL[tone]}
            </li>
          ))}
        </ul>
      </div>

      {isLoading ? (
        <Skeleton className="h-[420px]" />
      ) : list.error ? (
        <LoadError what="The calendar" error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <>
          <MonthGrid month={month} byDay={byDay} selectedDay={selectedDay} now={now} onSelectDay={setDayParam} onMoveTask={moveTask} />

          {/* The picked day's tasks */}
          <section className="mt-4" aria-labelledby="calendar-day-heading" data-testid="calendar-day-list">
            <h2 id="calendar-day-heading" className="mb-1.5 px-1 text-xs uppercase tracking-wider font-semibold text-ink-3">
              {selectedDay
                ? `${weekdayOf(selectedDay)}, ${formatIstDate(selectedDay)}${selectedDay === today ? " — today" : ""} · ${dayTasks.length} task${dayTasks.length === 1 ? "" : "s"} due`
                : "Press a day to see its tasks"}
            </h2>
            {selectedDay && (dayTasks.length === 0 ? (
              <EmptyState icon="calendar" title="No tasks due on this day." body="Add a task, or drag one here from another day." compact />
            ) : (
              <Card>
                <ul className="divide-y divide-hairline">
                  {dayTasks.map((t) => (
                    <TaskRow key={t.id} task={t} onEdit={setEditingTask} assignee={t.owner_id ? memberById.get(t.owner_id) : null} />
                  ))}
                </ul>
              </Card>
            ))}
          </section>
        </>
      )}

      <AddTaskDialog open={addOpen} onOpenChange={setAddOpen} linkTo={null} />
      {editingTask && (
        <AddTaskDialog
          open
          onOpenChange={(o) => { if (!o) setEditingTask(null); }}
          linkTo={null}
          linkLabel={taskLeadName(editingTask) ?? editingTask.customers?.name ?? editingTask.quotes?.customer_name ?? undefined}
          task={editingTask}
        />
      )}
    </div>
  );
}
