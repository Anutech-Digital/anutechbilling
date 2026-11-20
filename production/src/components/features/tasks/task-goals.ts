/**
 * R-2957 — goals: a goal is a task with sub-tasks under it (tasks.parent_task_id, tasks.is_goal).
 * Plain functions over rows already read — the base for the Goals screens (R-2958..R-2960);
 * nothing here is shown yet.
 *
 *   • The work is the sub-tasks: they are counted like any task everywhere; the goal row itself
 *     is in no count (task-groups.ts taskGroupOf → null, and every work read leaves it out).
 *   • "N of M done": M = the sub-tasks that are still work or finished — a cancelled sub-task is
 *     in neither number. N = the finished ones.
 *   • A goal's status comes from its sub-tasks: none started → Not started; one started, on hold
 *     or finished → In progress; all finished → Done. A goal with no sub-task yet has no status
 *     of its own to work out (null) — the screen shows the goal row's own.
 */
import { rowStatusOf } from "./task-progress";

export type GoalStatus = "not_started" | "in_progress" | "done";

export interface GoalProgress {
  /** Finished sub-tasks — the N of "N of M done". */
  done: number;
  /** Sub-tasks that count (not cancelled) — the M. */
  total: number;
  /** Still to do: total − done. */
  open: number;
  /** Whole percent for the bar (0 when there is nothing to count). */
  percent: number;
  status: GoalStatus | null;
}

type SubTaskLike = { status: string; progress?: string | null };

export function goalProgress(subTasks: readonly SubTaskLike[]): GoalProgress {
  let done = 0, total = 0, started = 0;
  for (const t of subTasks) {
    if (t.status === "cancelled") continue;
    total++;
    const s = rowStatusOf(t);
    if (s === "done") done++;
    if (s !== "not_started") started++;
  }
  const status: GoalStatus | null =
    total === 0 ? null : done === total ? "done" : started > 0 ? "in_progress" : "not_started";
  return { done, total, open: total - done, percent: total > 0 ? Math.round((done / total) * 100) : 0, status };
}

/** "2 of 5 done" — the one wording for a goal's progress. */
export function goalProgressLabel(p: Pick<GoalProgress, "done" | "total">): string {
  return `${p.done} of ${p.total} done`;
}

type GoalRowLike = SubTaskLike & { id: string; is_goal?: boolean | null; parent_task_id?: string | null; due_at?: string | null };

export interface GoalWithSubTasks<T> {
  goal: T;
  /** Every sub-task of the goal, cancelled ones included (the screen decides what to list), soonest due first. */
  subTasks: T[];
  progress: GoalProgress;
}

/**
 * Goals with their sub-tasks and progress, from ONE list of rows (the goals and the sub-tasks
 * together — fetchGoalRows in lib/queries/tasks.ts reads exactly that, so there is no request
 * per goal). A sub-task whose goal is not in the list (not readable, or deleted a moment ago) is
 * left out. Goals keep the order they came in.
 */
export function goalsWithSubTasks<T extends GoalRowLike>(rows: readonly T[]): GoalWithSubTasks<T>[] {
  const byGoal = new Map<string, T[]>();
  for (const r of rows) if (r.is_goal) byGoal.set(r.id, []);
  for (const r of rows) {
    if (r.is_goal || !r.parent_task_id) continue;
    byGoal.get(r.parent_task_id)?.push(r);
  }
  const due = (t: T) => (t.due_at ? Date.parse(t.due_at) : Number.POSITIVE_INFINITY);
  return rows.filter((r) => r.is_goal).map((goal) => {
    const subTasks = byGoal.get(goal.id)!.sort((a, b) => due(a) - due(b));
    return { goal, subTasks, progress: goalProgress(subTasks) };
  });
}

/**
 * Sub-task id → its goal's title, from the same one list — what a sub-task's row shows as
 * "part of …" without a lookup per row.
 */
export function goalTitleBySubTask<T extends GoalRowLike & { title: string }>(rows: readonly T[]): Map<string, string> {
  const title = new Map<string, string>();
  for (const r of rows) if (r.is_goal) title.set(r.id, r.title);
  const out = new Map<string, string>();
  for (const r of rows) {
    const t = r.parent_task_id ? title.get(r.parent_task_id) : undefined;
    if (t !== undefined) out.set(r.id, t);
  }
  return out;
}
