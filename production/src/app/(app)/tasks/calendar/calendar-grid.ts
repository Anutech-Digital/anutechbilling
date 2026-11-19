/**
 * R-2931 — the month grid behind /tasks/calendar. Pure: every day is an IST calendar date
 * (YYYY-MM-DD, lib/dates/ist), so the grid reads the same in any browser time zone.
 */
import { addDaysISO, istDayStartUtc, monthBounds, toIstDate, IST_OFFSET_MS } from "@/lib/dates/ist";
import { taskGroupOf } from "@/components/features/tasks/task-groups";
import type { Task } from "@/lib/supabase/database.types";

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** A real "YYYY-MM" month — the `?month=` URL value is checked with this. */
export function isMonth(value: string): boolean {
  const m = /^(\d{4})-(\d{2})$/.exec(value);
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 12;
}

/** `month` moved by `n` months ("2026-12" + 1 = "2027-01"). */
export function shiftMonth(month: string, n: number): string {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Monday-first weeks that cover the month; the first and last week carry the neighbours' days. */
export function monthWeeks(month: string): string[][] {
  const { start, end } = monthBounds(month);
  const mondayOffset = (new Date(`${start}T00:00:00Z`).getUTCDay() + 6) % 7; // Mon = 0
  const weeks: string[][] = [];
  for (let day = addDaysISO(start, -mondayOffset); day <= end; day = addDaysISO(day, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDaysISO(day, i)));
  }
  return weeks;
}

/** The UTC instants that bound the visible grid: `due_at >= fromISO` and `< toISO`. */
export function gridRangeUtc(month: string): { fromISO: string; toISO: string } {
  const weeks = monthWeeks(month);
  return {
    fromISO: istDayStartUtc(weeks[0][0]).toISOString(),
    toISO: istDayStartUtc(addDaysISO(weeks[weeks.length - 1][6], 1)).toISOString(),
  };
}

type Dated = Pick<Task, "status"> & { due_at: string | null };

/** Tasks keyed by their IST due day, earliest first. Cancelled tasks are left out. */
export function tasksByDay<T extends Dated>(tasks: readonly T[]): Map<string, T[]> {
  const by = new Map<string, T[]>();
  for (const t of tasks) {
    if (t.status === "cancelled" || !t.due_at) continue;
    const day = toIstDate(t.due_at);
    const list = by.get(day);
    if (list) list.push(t); else by.set(day, [t]);
  }
  for (const list of by.values()) list.sort((a, b) => Date.parse(a.due_at!) - Date.parse(b.due_at!));
  return by;
}

export type TaskTone = "done" | "overdue" | "today" | "upcoming";

/** The colour group of a task — the same split as the Tasks list (task-groups.ts). */
export function taskTone(task: Dated, now: Date = new Date()): TaskTone {
  const group = taskGroupOf(task, now);
  return group === "done" || group === "overdue" || group === "today" ? group : "upcoming";
}

/**
 * The new `due_at` when a task is dragged to `day`: that IST day, the same IST clock time.
 * null when the task is already due on that day (nothing to save).
 */
export function moveDueToDay(dueAt: string, day: string): string | null {
  if (toIstDate(dueAt) === day) return null;
  const msIntoIstDay = (Date.parse(dueAt) + IST_OFFSET_MS) % 86_400_000;
  return new Date(istDayStartUtc(day).getTime() + msIntoIstDay).toISOString();
}
