/**
 * R-2933 — "Working with" in the Add / Edit task dialog: pick up to 3 teammates who work on the
 * task with its owner. Each teammate is a toggle (pressed = picked); once 3 are picked the rest
 * are disabled and the line under the field says why.
 */
"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import { memberLabel, type TeamMember } from "@/lib/queries/team";
import { MAX_TASK_COLLABORATORS, toggleCollaborator } from "@/lib/tasks/collaborators";

export function TaskCollaboratorsField({ members, ownerId, value, onChange }: {
  members: readonly TeamMember[];
  /** The task's owner — never offered (they already have the task). */
  ownerId: string | null | undefined;
  value: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const choices = members.filter((m) => m.id !== ownerId);
  const full = value.length >= MAX_TASK_COLLABORATORS;
  if (choices.length === 0) {
    return <p className="text-2xs text-ink-3">No other teammates with a login yet.</p>;
  }
  return (
    <div>
      <div role="group" aria-label="Working with" className="flex flex-wrap gap-1.5">
        {choices.map((m) => {
          const picked = value.includes(m.id);
          return (
            <button
              key={m.id}
              type="button"
              aria-pressed={picked}
              disabled={!picked && full}
              onClick={() => onChange(toggleCollaborator(value, m.id).selected)}
              className={cn(
                "inline-flex items-center gap-1 min-h-8 rounded-full border px-2.5 py-1 text-xs transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber disabled:opacity-50 disabled:cursor-not-allowed",
                picked ? "bg-indigo-soft border-indigo text-indigo font-medium" : "border-hairline text-ink-2 hover:bg-paper-2",
              )}
            >
              {picked && <Icon name="check" size={12} />}
              {memberLabel(m)}
            </button>
          );
        })}
      </div>
      <p className="text-2xs text-ink-3 mt-1" aria-live="polite">
        {full
          ? `${MAX_TASK_COLLABORATORS} of ${MAX_TASK_COLLABORATORS} picked — remove one to add another.`
          : `Up to ${MAX_TASK_COLLABORATORS} teammates. They are told when you save, and see the task with their name on it.`}
      </p>
    </div>
  );
}
