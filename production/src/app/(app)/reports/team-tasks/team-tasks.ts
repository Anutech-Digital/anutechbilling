/**
 * R-2932 — the numbers behind Reports → Team tasks. Pure: tasks in, rows out.
 *
 *   • Workload per person: open (pending / snoozed), overdue (open and past its due time) and
 *     done this week (ticked since Monday).
 *   • 8-week trend: per week, tasks COMPLETED in it (by the time they were ticked) and tasks
 *     LATE in it (due in that week, and either still open past the due time or ticked after it).
 *
 * Days and weeks are IST, Monday → Sunday (lib/dates/ist). Cancelled tasks never count.
 */
import { addDaysISO, formatIstDate, istDayStartUtc, toIstDate } from "@/lib/dates/ist";
import type { Task } from "@/lib/supabase/database.types";

export const TREND_WEEKS = 8;

export type ReportTask = Pick<Task, "id" | "owner_id" | "status" | "due_at" | "completed_at">;
/** The columns the report reads — nothing about what a task says or whom it is for. */
export const REPORT_TASK_SELECT = "id, owner_id, status, due_at, completed_at";

/** Monday (YYYY-MM-DD) of the week `day` falls in. */
export function weekStart(day: string): string {
  const mondayOffset = (new Date(`${day.slice(0, 10)}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDaysISO(day, -mondayOffset);
}

export interface Week { start: string; end: string; label: string }

/** The last `n` weeks ending with the week of `today`, oldest first. Label = the Monday, "16 Nov". */
export function lastWeeks(today: string, n: number = TREND_WEEKS): Week[] {
  const current = weekStart(today);
  return Array.from({ length: n }, (_, i) => {
    const start = addDaysISO(current, -7 * (n - 1 - i));
    return { start, end: addDaysISO(start, 6), label: formatIstDate(start).replace(/ \d{4}$/, "") };
  });
}

/** IST midnight of the first trend week's Monday, as a UTC instant — the report reads from here. */
export function reportRangeStartUtc(now: Date = new Date(), n: number = TREND_WEEKS): string {
  return istDayStartUtc(lastWeeks(toIstDate(now), n)[0].start).toISOString();
}

/** Several reads of the same table, each task once (first one wins). */
export function mergeById<T extends { id: string }>(...lists: readonly T[][]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const list of lists) for (const row of list) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

const isOpen = (t: ReportTask) => t.status === "pending" || t.status === "snoozed";

export interface Member { id: string; full_name: string | null; email: string | null }
export interface WorkloadRow {
  /** The member's user id; null = the "Unassigned" row. */
  id: string | null;
  name: string;
  open: number;
  overdue: number;
  doneThisWeek: number;
}

export const UNASSIGNED_LABEL = "Unassigned";
const nameOf = (m: Member) => m.full_name || m.email?.split("@")[0] || "Teammate";

/**
 * One row per current team member (zeros included), furthest behind first: most overdue,
 * then most open, then name. Tasks with no owner — or whose owner is no longer in the team —
 * are one last "Unassigned" row, shown only when there are any.
 */
export function teamWorkload(tasks: readonly ReportTask[], members: readonly Member[], now: Date = new Date()): WorkloadRow[] {
  const thisWeek = weekStart(toIstDate(now));
  const rows = new Map<string | null, WorkloadRow>(
    members.map((m) => [m.id, { id: m.id, name: nameOf(m), open: 0, overdue: 0, doneThisWeek: 0 }]),
  );
  const unassigned: WorkloadRow = { id: null, name: UNASSIGNED_LABEL, open: 0, overdue: 0, doneThisWeek: 0 };

  for (const t of tasks) {
    const row = (t.owner_id ? rows.get(t.owner_id) : undefined) ?? unassigned;
    if (isOpen(t)) {
      row.open += 1;
      if (Date.parse(t.due_at) < now.getTime()) row.overdue += 1;
    } else if (t.status === "done" && t.completed_at && toIstDate(t.completed_at) >= thisWeek) {
      row.doneThisWeek += 1;
    }
  }

  const sorted = [...rows.values()].sort(
    (a, b) => b.overdue - a.overdue || b.open - a.open || a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
  );
  const anyUnassigned = unassigned.open + unassigned.doneThisWeek > 0;
  return anyUnassigned ? [...sorted, unassigned] : sorted;
}

export interface TrendWeek extends Week { completed: number; late: number }

/** Completed vs late for each of the last `n` weeks (zeros included), oldest first. */
export function weeklyTrend(tasks: readonly ReportTask[], now: Date = new Date(), n: number = TREND_WEEKS): TrendWeek[] {
  const weeks: TrendWeek[] = lastWeeks(toIstDate(now), n).map((w) => ({ ...w, completed: 0, late: 0 }));
  const byStart = new Map(weeks.map((w) => [w.start, w]));
  const weekOf = (at: string) => byStart.get(weekStart(toIstDate(at)));

  for (const t of tasks) {
    if (t.status === "cancelled") continue;
    if (t.status === "done" && t.completed_at) {
      const w = weekOf(t.completed_at);
      if (w) w.completed += 1;
    }
    const due = Date.parse(t.due_at);
    const late = isOpen(t)
      ? due < now.getTime()
      : t.status === "done" && !!t.completed_at && Date.parse(t.completed_at) > due;
    if (late) {
      const w = weekOf(t.due_at);
      if (w) w.late += 1;
    }
  }
  return weeks;
}
