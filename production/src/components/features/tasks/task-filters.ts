/**
 * R-2938 — the Tasks page's one filter bar: Status, Priority and Assignee (next to the search).
 * Plain functions; the page keeps the three choices in the address (`?status=&priority=&assignee=`)
 * so a reload, Back or a shared link opens the same view.
 *
 *   • What a choice lets through — `matchesTaskFilters`. Status is the row's own status
 *     (task-progress.ts: Not started / In progress / On hold / Done), priority is task-priority's
 *     (a row with none reads Medium), "mine" is the signed-in person.
 *   • The number beside each option — `taskFilterCounts`. ONE rule: it is how many OPEN tasks
 *     you get by picking that option with the other filters (and the search) kept. Finished
 *     tasks are counted only where Done is the status in question: the "Done" option itself,
 *     and Priority / Assignee while Status = Done is picked. Cancelled tasks are never listed,
 *     so never counted.
 *   • Who is offered under Assignee — `taskAssigneeOptions`.
 */
import { TASK_PRIORITY_FILTERS, TASK_STATUS_FILTERS } from "@/lib/navigation/drilldown";
import { priorityOf } from "./task-priority";
import { rowStatusOf } from "./task-progress";

export type TaskStatusFilter = (typeof TASK_STATUS_FILTERS)[number];
export type TaskPriorityFilter = (typeof TASK_PRIORITY_FILTERS)[number];

export interface TaskFilters {
  status: TaskStatusFilter;
  priority: TaskPriorityFilter;
  /** "all", "mine", or a teammate's user id. */
  assignee: string;
}

export const NO_TASK_FILTERS: TaskFilters = { status: "all", priority: "all", assignee: "all" };

export function hasTaskFilters(f: TaskFilters): boolean {
  return f.status !== "all" || f.priority !== "all" || f.assignee !== "all";
}

type Filterable = { status: string; progress?: string | null; priority?: string | null; owner_id: string | null };

const statusOk = (t: Filterable, s: TaskStatusFilter) => s === "all" || rowStatusOf(t) === s;
const priorityOk = (t: Filterable, p: TaskPriorityFilter) => p === "all" || priorityOf(t) === p;
function assigneeOk(t: Filterable, a: string, meId: string | null | undefined): boolean {
  if (a === "all") return true;
  if (a === "mine") return !!meId && t.owner_id === meId; // not known yet → nothing, never everyone's
  return t.owner_id === a;
}

/** Does the task pass all three choices? */
export function matchesTaskFilters(task: Filterable, f: TaskFilters, meId: string | null | undefined): boolean {
  return statusOk(task, f.status) && priorityOk(task, f.priority) && assigneeOk(task, f.assignee, meId);
}

export interface TaskFilterCounts {
  status: Record<TaskStatusFilter, number>;
  priority: Record<TaskPriorityFilter, number>;
  assignee: { all: number; mine: number; byOwner: Map<string, number> };
}

/**
 * The number beside each option (see the rule at the top). `tasks` is the set the list would
 * show with no filter bar choice — the page passes the tasks that already match the search.
 */
export function taskFilterCounts(
  tasks: readonly Filterable[], f: TaskFilters, meId: string | null | undefined,
): TaskFilterCounts {
  const status = Object.fromEntries(TASK_STATUS_FILTERS.map((s) => [s, 0])) as Record<TaskStatusFilter, number>;
  const priority = Object.fromEntries(TASK_PRIORITY_FILTERS.map((p) => [p, 0])) as Record<TaskPriorityFilter, number>;
  const assignee = { all: 0, mine: 0, byOwner: new Map<string, number>() };

  for (const t of tasks) {
    if (t.status === "cancelled") continue;
    const row = rowStatusOf(t);
    const open = row !== "done";
    /* "All statuses" in a number means the open ones; a picked status means exactly that status. */
    const inPickedStatus = f.status === "all" ? open : row === f.status;
    const p = priorityOk(t, f.priority);
    const a = assigneeOk(t, f.assignee, meId);

    if (p && a) {
      status[row]++;
      if (open) status.all++;
    }
    if (inPickedStatus && a) {
      priority[priorityOf(t)]++;
      priority.all++;
    }
    if (inPickedStatus && p) {
      assignee.all++;
      if (t.owner_id) {
        assignee.byOwner.set(t.owner_id, (assignee.byOwner.get(t.owner_id) ?? 0) + 1);
        if (meId && t.owner_id === meId) assignee.mine++;
      }
    }
  }
  return { status, priority, assignee };
}

type MemberLike = { id: string; full_name?: string | null; email?: string | null; access_ends_on?: string | null };

export interface AssigneeOption { id: string; label: string }

const nameOf = (m: MemberLike) => m.full_name || m.email?.split("@")[0] || "Teammate";

/**
 * The teammates offered under Assignee, by name. The old chips showed every login, test and
 * spare ones included, and wrapped onto two lines. Offered now:
 *   • a login that owns at least one task on the page (open or recently done) — a login with no
 *     task has nothing to filter to, which is what a test / spare login looks like (there is no
 *     "test user" mark in the data);
 *   • one whose access has ended (`access_ends_on` before today, IST) only while they still own
 *     an OPEN task — the owner must be able to find and hand over that work; `members` already
 *     leaves out deactivated logins (useTeamMembers);
 *   • not the signed-in person — that is the "Mine" option.
 * Whoever the address names is always offered, so the box can show what is filtered; until the
 * team has loaded (`membersReady` false) that person is named "Teammate", never "Former teammate".
 */
export function taskAssigneeOptions(
  members: readonly MemberLike[],
  tasks: readonly Filterable[],
  meId: string | null | undefined,
  selected: string,
  today: string,
  membersReady = true,
): AssigneeOption[] {
  const hasTask = new Set<string>();
  const hasOpenTask = new Set<string>();
  for (const t of tasks) {
    if (!t.owner_id || t.status === "cancelled") continue;
    hasTask.add(t.owner_id);
    if (rowStatusOf(t) !== "done") hasOpenTask.add(t.owner_id);
  }
  const picked = selected !== "all" && selected !== "mine" && selected !== meId ? selected : null;
  const active = (m: MemberLike) => !m.access_ends_on || m.access_ends_on >= today;

  const options = members
    .filter((m) => m.id !== meId)
    .filter((m) => m.id === picked || (active(m) ? hasTask.has(m.id) : hasOpenTask.has(m.id)))
    .map((m) => ({ id: m.id, label: nameOf(m) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (picked && !options.some((o) => o.id === picked)) {
    options.push({ id: picked, label: membersReady ? "Former teammate" : "Teammate" });
  }
  return options;
}

/** The Tasks list with a status and / or priority picked — where an Overview donut line goes. */
export function tasksFilterHref(f: { status?: TaskStatusFilter; priority?: TaskPriorityFilter }): string {
  const p = new URLSearchParams();
  if (f.status && f.status !== "all") p.set("status", f.status);
  if (f.priority && f.priority !== "all") p.set("priority", f.priority);
  const qs = p.toString();
  return qs ? `/tasks?${qs}` : "/tasks";
}
