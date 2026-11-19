/**
 * R-2930 — the Tasks page's search, summary cards and the "This week / Later" split of Upcoming.
 * Plain functions; every day boundary is the IST calendar day (lib/dates/ist), like task-groups.
 * A week runs Monday to Sunday.
 */
import { addDaysISO, toIstDate } from "@/lib/dates/ist";
import { taskGroupOf, type TaskGroup, type TaskGroupId } from "./task-groups";

type Searchable = {
  title: string;
  notes?: string | null;
  leads?: { company?: string | null; contact_name?: string | null; contact_email?: string | null; contact_phone?: string | null } | null;
  customers?: { name?: string | null; contact_name?: string | null; contact_email?: string | null; contact_phone?: string | null } | null;
  quotes?: { customer_name?: string | null } | null;
};

/** Every word typed must be found in the task's name, notes, or the lead / customer / deal it is
 *  about — its name, contact, email or phone (everything the row can show for it). */
export function matchesTaskSearch(task: Searchable, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [
    task.title, task.notes,
    task.leads?.company, task.leads?.contact_name, task.leads?.contact_email, task.leads?.contact_phone,
    task.customers?.name, task.customers?.contact_name, task.customers?.contact_email, task.customers?.contact_phone,
    task.quotes?.customer_name,
  ].filter(Boolean).join(" \n ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Monday and Sunday (IST dates) of the week `now` is in. */
export function istWeekBounds(now: Date = new Date()): { start: string; end: string } {
  const today = toIstDate(now);
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const start = addDaysISO(today, -((dow + 6) % 7));
  return { start, end: addDaysISO(start, 6) };
}

export interface TaskSummary { open: number; overdue: number; today: number; doneThisWeek: number }

type Summable = { status: string; due_at: string | null; completed_at?: string | null };

/**
 * The four cards. Open = every task still to do (overdue + today + upcoming + no date) — the
 * same groups the list shows, so a card and the tab it opens never disagree.
 */
export function taskSummary(tasks: readonly Summable[], now: Date = new Date()): TaskSummary {
  const week = istWeekBounds(now);
  const s: TaskSummary = { open: 0, overdue: 0, today: 0, doneThisWeek: 0 };
  for (const t of tasks) {
    const g = taskGroupOf(t as Parameters<typeof taskGroupOf>[0], now);
    if (!g) continue;
    if (g === "done") {
      const day = t.completed_at ? toIstDate(t.completed_at) : null;
      if (day && day >= week.start && day <= week.end) s.doneThisWeek++;
      continue;
    }
    s.open++;
    if (g === "overdue") s.overdue++;
    else if (g === "today") s.today++;
  }
  return s;
}

export type TaskSectionId = Exclude<TaskGroupId, "upcoming"> | "week" | "later";
export interface TaskSection<T> { id: TaskSectionId; group: TaskGroupId; label: string; tasks: T[] }

/**
 * The sections the list renders: the groups as they are, with Upcoming split into "This week"
 * (due by Sunday) and "Later". Order inside a section is the group's own (High first, then due).
 * The tabs and their counts still work on the groups — Upcoming = This week + Later.
 */
export function taskSections<T extends { due_at: string | null }>(
  groups: readonly TaskGroup<T>[], now: Date = new Date(),
): TaskSection<T>[] {
  const weekEnd = istWeekBounds(now).end;
  const thisWeek = (t: T) => !!t.due_at && toIstDate(t.due_at) <= weekEnd;
  const out: TaskSection<T>[] = [];
  for (const g of groups) {
    if (g.id !== "upcoming") { out.push({ id: g.id, group: g.id, label: g.label, tasks: g.tasks }); continue; }
    out.push({ id: "week", group: "upcoming", label: "This week", tasks: g.tasks.filter(thisWeek) });
    out.push({ id: "later", group: "upcoming", label: "Later", tasks: g.tasks.filter((t) => !thisWeek(t)) });
  }
  return out;
}
