/**
 * R-2927 — the status menu on a task row: Not started / In progress / On hold / Done.
 * One click on the badge, pick the status. The row owns the saves (one set of mutations per
 * row, one in-flight guard shared with the done circle) and passes `onPick`; the rules of what
 * a pick means are in task-progress.ts.
 */
"use client";

import * as React from "react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel, DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { TASK_ROW_STATUSES, TASK_ROW_STATUS_META, rowStatusOf, type TaskRowStatus } from "./task-progress";

export function TaskStatusMenu({ task, busy, onPick }: {
  task: { title: string; status: string; progress?: string | null };
  /** A save for this row is in flight — picks are ignored (the trigger stays focusable). */
  busy: boolean;
  onPick: (next: TaskRowStatus) => void;
}) {
  const current = rowStatusOf(task);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-busy={busy || undefined}
          aria-label={`Status: ${TASK_ROW_STATUS_META[current].label} — change status of ${task.title}`}
          /* 36px tall on a phone (same as the done circle), compact from sm up. */
          className="inline-flex items-center min-h-9 sm:min-h-6 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
        >
          <Badge kind={TASK_ROW_STATUS_META[current].badge} className="gap-1 cursor-pointer">
            {TASK_ROW_STATUS_META[current].label}
            <Icon name="chevron_down" size={10} />
          </Badge>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[160px]">
        <DropdownMenuLabel>Status</DropdownMenuLabel>
        {/* Checkbox items: the current status is announced as checked (and shows the tick). */}
        {TASK_ROW_STATUSES.map((s: TaskRowStatus) => (
          <DropdownMenuCheckboxItem key={s} checked={s === current} onCheckedChange={() => { if (!busy) onPick(s); }}>
            {TASK_ROW_STATUS_META[s].label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
