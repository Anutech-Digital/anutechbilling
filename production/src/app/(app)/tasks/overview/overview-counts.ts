/**
 * R-2936 — the numbers of Tasks → Overview. Plain functions over the rows the Tasks list
 * already reads (useTaskList): every open task + the newest done ones. "Open" and the day
 * groups are task-groups' own (IST days, R-471 "past its time = Overdue"), so a number here
 * and the tab it opens on /tasks never disagree.
 */
import { monthBounds, toIstDate } from "@/lib/dates/ist";
import { taskGroupOf, type TaskTabId } from "@/components/features/tasks/task-groups";
import { istWeekBounds } from "@/components/features/tasks/task-overview";
import { TASK_PRIORITIES, TASK_PRIORITY_META, priorityOf, priorityRank, type TaskPriority } from "@/components/features/tasks/task-priority";
import { TASK_PROGRESS, TASK_ROW_STATUS_META, rowStatusOf, type TaskProgress } from "@/components/features/tasks/task-progress";

type Countable = {
  status: string;
  due_at: string | null;
  completed_at?: string | null;
  priority?: string | null;
  progress?: string | null;
};

type GroupArg = Parameters<typeof taskGroupOf>[0];

/** Still to do: in a list group and not Done (cancelled tasks are in no group). */
function isOpen(task: Countable, now: Date): boolean {
  const g = taskGroupOf(task as GroupArg, now);
  return g !== null && g !== "done";
}

export interface Slice<Id extends string = string> { id: Id; label: string; count: number }

/** Open tasks by the step set on the row (R-2927): Not started / In progress / On hold. */
export function statusSlices(tasks: readonly Countable[], now: Date = new Date()): Slice<TaskProgress>[] {
  const count = new Map<TaskProgress, number>(TASK_PROGRESS.map((p) => [p, 0]));
  for (const t of tasks) {
    if (!isOpen(t, now)) continue;
    const s = rowStatusOf(t);
    if (s !== "done") count.set(s, count.get(s)! + 1);
  }
  return TASK_PROGRESS.map((id) => ({ id, label: TASK_ROW_STATUS_META[id].label, count: count.get(id)! }));
}

/** Open tasks by priority (R-2926), High first. */
export function prioritySlices(tasks: readonly Countable[], now: Date = new Date()): Slice<TaskPriority>[] {
  const count = new Map<TaskPriority, number>(TASK_PRIORITIES.map((p) => [p, 0]));
  for (const t of tasks) {
    if (!isOpen(t, now)) continue;
    const p = priorityOf(t);
    count.set(p, count.get(p)! + 1);
  }
  return [...TASK_PRIORITIES]
    .sort((a, b) => priorityRank(a) - priorityRank(b))
    .map((id) => ({ id, label: TASK_PRIORITY_META[id].label, count: count.get(id)! }));
}

/** A slice's share of the total as a whole percent (0 when there is nothing to share). */
export function sliceShare(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * 100) : 0;
}

export interface DueStrip {
  overdue: number;
  /** Due later today (a task whose time has passed is Overdue). */
  today: number;
  /** Still ahead (later today or after), due by Sunday. */
  thisWeek: number;
  /** Still ahead (later today or after), due by the last day of this month. */
  thisMonth: number;
  weekEnd: string;
  monthEnd: string;
}

/**
 * Open tasks by when they fall due. Overdue and Today are the Tasks page's own tabs. This week
 * and This month count what is still ahead — Today's tasks included, so on a Sunday "This week"
 * is today's tasks and never a blank 0 — up to Sunday / the month's last day. Overdue tasks are
 * in neither. A week that runs into next month can hold more than the month does.
 */
export function dueStrip(tasks: readonly Countable[], now: Date = new Date()): DueStrip {
  const weekEnd = istWeekBounds(now).end;
  const monthEnd = monthBounds(toIstDate(now)).end;
  const out: DueStrip = { overdue: 0, today: 0, thisWeek: 0, thisMonth: 0, weekEnd, monthEnd };
  for (const t of tasks) {
    const g = taskGroupOf(t as GroupArg, now);
    if (g === "overdue") { out.overdue++; continue; }
    if (g === "today") out.today++;
    if ((g === "today" || g === "upcoming") && t.due_at) {
      const day = toIstDate(t.due_at);
      if (day <= weekEnd) out.thisWeek++;
      if (day <= monthEnd) out.thisMonth++;
    }
  }
  return out;
}

export const OVERVIEW_LIST_SIZE = 5;

/** The next open tasks still ahead (due later today or after), soonest first. */
export function upcomingTasks<T extends Countable>(tasks: readonly T[], now: Date = new Date(), limit = OVERVIEW_LIST_SIZE): T[] {
  return tasks
    .filter((t) => {
      const g = taskGroupOf(t as GroupArg, now);
      return g === "today" || g === "upcoming";
    })
    .sort((a, b) => Date.parse(a.due_at!) - Date.parse(b.due_at!))
    .slice(0, limit);
}

/** The newest open tasks, newest first. */
export function newlyAddedTasks<T extends Countable & { created_at: string }>(
  tasks: readonly T[], limit = OVERVIEW_LIST_SIZE, now: Date = new Date(),
): T[] {
  return tasks
    .filter((t) => isOpen(t, now))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, limit);
}

/** The Tasks list on one of its tabs (`?tab=`, lib/navigation/drilldown TASK_TABS). */
export function tasksTabHref(tab: TaskTabId): string {
  return `/tasks?tab=${tab}`;
}

/** The Tasks list with one task opened (`?task=<id>`, R-341). */
export function taskHref(id: string): string {
  return `/tasks?task=${encodeURIComponent(id)}`;
}
