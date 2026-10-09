/**
 * R-354 — /tasks list groups by the IST calendar day: Overdue, Today, Upcoming, No date,
 * Done. A task due at 23:59 IST today is Today; one due at 00:01 IST tomorrow is Upcoming —
 * whatever zone the browser is in (lib/dates/ist). R-471: a task whose due time has
 * already passed is Overdue, even if that time was earlier today.
 */
import { toIstDate } from "@/lib/dates/ist";
import type { Task } from "@/lib/supabase/database.types";

export type TaskGroupId = "overdue" | "today" | "upcoming" | "nodate" | "done";

export const TASK_GROUP_ORDER: readonly TaskGroupId[] = ["overdue", "today", "upcoming", "nodate", "done"];

export const TASK_GROUP_LABEL: Record<TaskGroupId, string> = {
  overdue: "Overdue",
  today: "Today",
  upcoming: "Upcoming",
  nodate: "No date",
  done: "Done",
};

type Groupable = Pick<Task, "status"> & { due_at: string | null; completed_at?: string | null };

/** The group a task falls in; null for cancelled tasks (not shown). */
export function taskGroupOf(task: Groupable, now: Date = new Date()): TaskGroupId | null {
  if (task.status === "done") return "done";
  if (task.status === "cancelled") return null;
  if (!task.due_at) return "nodate";
  /* R-471: past the due moment = Overdue, even earlier today. Grouping by day alone left a
     10 am call in Today at noon while its row said "⚠ Overdue" and the Overdue tab said
     "Inbox zero". Today = the rest of today (IST). */
  if (Date.parse(task.due_at) < now.getTime()) return "overdue";
  const day = toIstDate(task.due_at);
  const today = toIstDate(now);
  return day <= today ? "today" : "upcoming";
}

export interface TaskGroup<T> {
  id: TaskGroupId;
  label: string;
  tasks: T[];
}

/**
 * Every group in TASK_GROUP_ORDER (empty ones included — the page decides what to hide).
 * Open groups run soonest-due first; Done runs most recently completed first.
 */
export function groupTasks<T extends Groupable>(tasks: readonly T[], now: Date = new Date()): TaskGroup<T>[] {
  const by = new Map<TaskGroupId, T[]>(TASK_GROUP_ORDER.map((id) => [id, []]));
  for (const t of tasks) {
    const g = taskGroupOf(t, now);
    if (g) by.get(g)!.push(t);
  }
  const due = (t: T) => (t.due_at ? Date.parse(t.due_at) : 0);
  const doneAt = (t: T) => Date.parse(t.completed_at ?? t.due_at ?? "") || 0;
  return TASK_GROUP_ORDER.map((id) => {
    const list = by.get(id)!;
    list.sort(id === "done" ? (a, b) => doneAt(b) - doneAt(a) : (a, b) => due(a) - due(b));
    return { id, label: TASK_GROUP_LABEL[id], tasks: list };
  });
}
