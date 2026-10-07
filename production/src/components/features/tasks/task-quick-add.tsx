/**
 * R-354 — quick-add bar at the top of /tasks. Type "Call Amit tomorrow 3 PM", press Enter:
 * the task is saved with the title and due time read from the text (quick-add-parse.ts).
 * Below the box it always says what will be saved, and says so plainly when no day or time
 * was found and the default (today 6 PM) is being used.
 */
"use client";

import * as React from "react";
import { useCreateTask } from "@/lib/queries/tasks";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { IST_TZ } from "@/lib/dates/ist";
import { cn } from "@/lib/utils";
import { parseQuickAdd } from "./quick-add-parse";
import { KIND_META } from "./task-row";

export function TaskQuickAdd() {
  const createTask = useCreateTask();
  const [text, setText] = React.useState("");
  const parsed = React.useMemo(() => (text.trim() ? parseQuickAdd(text) : null), [text]);
  const canSave = !!parsed && parsed.title.length > 0 && !createTask.isPending;

  const save = () => {
    if (!parsed || !canSave) return;
    createTask.mutate(
      { title: parsed.title, kind: parsed.kind, due_at: parsed.dueAt.toISOString() },
      { onSuccess: () => setText("") },
    );
  };

  const when = parsed?.dueAt.toLocaleString("en-IN", {
    weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: IST_TZ,
  });
  const guessed = parsed && (!parsed.understood.date || !parsed.understood.time);

  return (
    <div className="mb-4">
      <form
        className="flex gap-2"
        onSubmit={(e) => { e.preventDefault(); save(); }}
      >
        <Input
          aria-label="Quick add a task"
          placeholder="Quick add: Call Amit tomorrow 3 PM"
          value={text}
          onChange={(e) => setText(e.target.value)}
          prefix={<Icon name="plus" size={14} />}
          enterKeyHint="done"
          autoComplete="off"
          maxLength={200}
        />
        <Button type="submit" variant="default" disabled={!canSave} loading={createTask.isPending}>
          Add
        </Button>
      </form>
      {parsed && (
        <p className="mt-1.5 text-xs text-ink-3" aria-live="polite">
          {parsed.title ? (
            <>
              Will save: <span aria-hidden="true">{KIND_META[parsed.kind].icon}</span>{" "}
              <span className="font-medium text-ink-2">{parsed.title}</span> ·{" "}
              <span className={cn("tabular-nums", guessed ? "text-amber-ink" : "text-ink-2")}>{when}</span>
              {guessed && (
                <span className="text-amber-ink">
                  {!parsed.understood.date && !parsed.understood.time
                    ? " — no day or time found, using the default"
                    : !parsed.understood.time
                    ? " — no time found, using 6 PM"
                    : " — no day found"}
                </span>
              )}
              <span className="hidden sm:inline"> · Enter to save</span>
            </>
          ) : (
            <span className="text-amber-ink">Add what the task is, e.g. “Call Amit”.</span>
          )}
        </p>
      )}
    </div>
  );
}
