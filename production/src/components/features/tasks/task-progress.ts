/**
 * R-2927 — what a person can set a task to from its row: Not started / In progress / On hold / Done.
 *
 * "In progress" and "On hold" are a STEP of an open task (tasks.progress), not new values of
 * tasks.status. status stays 'pending' for all three, so everything that counts or closes open
 * tasks — the Overdue badge (nav_badges), Today (today_inbox), performance points, the bell, and
 * the payment / renewal functions that finish or remove auto tasks by `status in ('pending',
 * 'snoozed')` — keeps treating them as open without being rewritten. Decision recorded on the card.
 */
export const TASK_PROGRESS = ["not_started", "in_progress", "on_hold"] as const;
export type TaskProgress = (typeof TASK_PROGRESS)[number];

/** The choices of the row's status menu, in order. */
export const TASK_ROW_STATUSES = ["not_started", "in_progress", "on_hold", "done"] as const;
export type TaskRowStatus = (typeof TASK_ROW_STATUSES)[number];

export const TASK_ROW_STATUS_META: Record<TaskRowStatus, { label: string; badge: "muted" | "info" | "warning" | "success" }> = {
  not_started: { label: "Not started", badge: "muted" },
  in_progress: { label: "In progress", badge: "info" },
  on_hold:     { label: "On hold",     badge: "warning" },
  done:        { label: "Done",        badge: "success" },
};

export function isTaskProgress(v: unknown): v is TaskProgress {
  return typeof v === "string" && (TASK_PROGRESS as readonly string[]).includes(v);
}

/** What the row shows: Done for a finished task, else its step (a row from before the column = Not started). */
export function rowStatusOf(task: { status: string; progress?: string | null }): TaskRowStatus {
  if (task.status === "done") return "done";
  return isTaskProgress(task.progress) ? task.progress : "not_started";
}

/**
 * The change a pick in the status menu means. `complete` / `reopen` go through the existing
 * one-click-done and Undo paths (completion stamps are the DB trigger's); `progress` is the step
 * to save. Picking what the task already is does nothing.
 */
export function rowStatusChange(
  task: { status: string; progress?: string | null },
  next: TaskRowStatus,
): { complete?: true; reopen?: true; progress?: TaskProgress } | null {
  const cur = rowStatusOf(task);
  if (cur === next) return null;
  if (next === "done") return { complete: true };
  return { ...(cur === "done" ? { reopen: true as const } : {}), progress: next };
}
