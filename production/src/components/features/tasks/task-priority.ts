/**
 * R-2926 — task priority: Low / Medium / High (tasks.priority, default medium).
 * One place for the levels, their words and colours, and the sort order.
 */
export const TASK_PRIORITIES = ["low", "medium", "high"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const DEFAULT_TASK_PRIORITY: TaskPriority = "medium";

/** Badge kinds are the app's own (components/ui/badge): red, amber, grey — always with the word. */
export const TASK_PRIORITY_META: Record<TaskPriority, { label: string; badge: "danger" | "warning" | "muted" }> = {
  high:   { label: "High",   badge: "danger" },
  medium: { label: "Medium", badge: "warning" },
  low:    { label: "Low",    badge: "muted" },
};

export function isTaskPriority(v: unknown): v is TaskPriority {
  return typeof v === "string" && (TASK_PRIORITIES as readonly string[]).includes(v);
}

/** A task's priority; a row from before the column, or an unknown value, reads as Medium. */
export function priorityOf(task: { priority?: string | null }): TaskPriority {
  return isTaskPriority(task.priority) ? task.priority : DEFAULT_TASK_PRIORITY;
}

/** The row shows a badge only for High and Low — Medium is the default and would be noise on every row. */
export function showsPriorityBadge(p: TaskPriority): boolean {
  return p !== DEFAULT_TASK_PRIORITY;
}

/** The priority part of a NEW task: left out when it is the default, so the DB default applies. */
export function priorityForCreate(p: TaskPriority): { priority?: TaskPriority } {
  return p === DEFAULT_TASK_PRIORITY ? {} : { priority: p };
}

/** Sort key: High 0, Medium 1, Low 2. */
export function priorityRank(p: TaskPriority): number {
  return p === "high" ? 0 : p === "medium" ? 1 : 2;
}
