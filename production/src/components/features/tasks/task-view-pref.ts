/**
 * R-2937 — how the /tasks list is drawn: "compact" (one line a task — the default) or
 * "comfortable" (the earlier roomy card). The choice is remembered on this browser, per user
 * (like the page's Summary strip, collapsible-kpi-strip.tsx) — on a shared computer one
 * teammate's choice does not become the next login's.
 *
 * Storage can be blocked (private window, embedded view): a read then gives the default and a
 * write is skipped — the toggle still works for the visit.
 */
"use client";

import * as React from "react";

export const TASK_DENSITIES = ["compact", "comfortable"] as const;
export type TaskDensity = (typeof TASK_DENSITIES)[number];
export const DEFAULT_TASK_DENSITY: TaskDensity = "compact";
/** The storage key for one user; null until we know who is signed in (nothing is read or written). */
export function taskDensityKey(userId: string | null | undefined): string | null {
  return userId ? `ros.tasks.list-density.${userId}` : null;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): StorageLike | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

/** The remembered choice; the default when nothing (or anything else) is stored. */
export function readTaskDensity(userId: string | null | undefined, storage: StorageLike | null = browserStorage()): TaskDensity {
  const key = taskDensityKey(userId);
  if (!key) return DEFAULT_TASK_DENSITY;
  try {
    const v = storage?.getItem(key);
    return v === "comfortable" || v === "compact" ? v : DEFAULT_TASK_DENSITY;
  } catch {
    return DEFAULT_TASK_DENSITY; // storage blocked
  }
}

export function writeTaskDensity(userId: string | null | undefined, density: TaskDensity, storage: StorageLike | null = browserStorage()): void {
  const key = taskDensityKey(userId);
  if (!key) return;
  try { storage?.setItem(key, density); } catch { /* storage blocked */ }
}

/** The list's density and its setter. Starts as the default (server and first paint agree), then
 *  takes the remembered choice. */
export function useTaskDensity(userId: string | null | undefined): [TaskDensity, (next: TaskDensity) => void] {
  const [density, setDensity] = React.useState<TaskDensity>(DEFAULT_TASK_DENSITY);
  React.useEffect(() => { setDensity(readTaskDensity(userId)); }, [userId]);
  const set = React.useCallback((next: TaskDensity) => { setDensity(next); writeTaskDensity(userId, next); }, [userId]);
  return [density, set];
}
