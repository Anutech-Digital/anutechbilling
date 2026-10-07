"use client";
/** The drawer's Follow-ups tab — open tasks up front, done ones folded away (S35, moved verbatim). */
import * as React from "react";
import { Button, IconButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { IST_TZ } from "@/lib/dates/ist";
import type { useTasksForLead, useCompleteTask, useSnoozeTask, useDeleteTask } from "@/lib/queries/tasks";

type TaskRow = NonNullable<ReturnType<typeof useTasksForLead>["data"]>[number];

export interface LeadFollowupsTabProps {
  openTasks: TaskRow[];
  doneTasks: TaskRow[];
  setAddTaskOpen: (open: boolean) => void;
  completeTask: ReturnType<typeof useCompleteTask>;
  snoozeTask: ReturnType<typeof useSnoozeTask>;
  deleteTask: ReturnType<typeof useDeleteTask>;
}

export function LeadFollowupsTab({ openTasks, doneTasks, setAddTaskOpen, completeTask, snoozeTask, deleteTask }: LeadFollowupsTabProps) {
  return (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs uppercase tracking-wider text-ink-3 font-semibold inline-flex items-center gap-2">
                <Icon name="clock" size={12} />
                Follow-ups
                {openTasks.length > 0 && (
                  <span className="text-3xs tabular-nums bg-amber-soft text-amber-ink px-1.5 py-0.5 rounded-full">
                    {openTasks.length} open
                  </span>
                )}
              </div>
              <Button size="sm" variant="ghost" icon="plus" onClick={() => setAddTaskOpen(true)}>
                Add follow-up
              </Button>
            </div>

            {openTasks.length === 0 && doneTasks.length === 0 ? (
              <p className="text-[12px] text-ink-3 italic">
                No follow-ups scheduled.
              </p>
            ) : (
              <div className="space-y-1.5">
                {openTasks.map((t) => {
                  const due = new Date(t.due_at);
                  const isOverdue = due.getTime() < Date.now();
                  return (
                    <div
                      key={t.id}
                      className={cn(
                        "rounded-md border px-3 py-2 text-sm flex items-start gap-2",
                        isOverdue
                          ? "border-rose/40 bg-rose-soft/40"
                          : "border-hairline bg-paper-2/30",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => completeTask.mutate(t.id)}
                        className="mt-0.5 w-4 h-4 rounded-full border border-hairline-strong hover:bg-emerald hover:border-emerald transition-colors shrink-0"
                        title="Mark done"
                        aria-label="Mark done"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-ink leading-tight">{t.title}</p>
                        <p className={cn(
                          "text-xs mt-0.5 tabular-nums",
                          isOverdue ? "text-rose font-medium" : "text-ink-3",
                        )}>
                          {isOverdue ? "Overdue · " : ""}
                          {due.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: IST_TZ })}
                          {t.snooze_count > 0 && ` · snoozed ${t.snooze_count}×`}
                        </p>
                        {t.notes && (
                          <p className="text-xs text-ink-3 mt-1 line-clamp-2">{t.notes}</p>
                        )}
                      </div>
                      <div className="flex gap-0.5 shrink-0">
                        <IconButton
                          icon="clock"
                          size="sm"
                          variant="ghost"
                          aria-label="Snooze 1 day"
                          title="Snooze 1 day"
                          onClick={() => snoozeTask.mutate({ id: t.id })}
                        />
                        <IconButton
                          icon="trash"
                          size="sm"
                          variant="ghost"
                          aria-label="Delete task"
                          title="Delete task"
                          onClick={() => deleteTask.mutate(t.id)}
                        />
                      </div>
                    </div>
                  );
                })}
                {doneTasks.length > 0 && (
                  <details className="text-xs text-ink-3 mt-2">
                    <summary className="cursor-pointer select-none hover:text-ink">
                      {doneTasks.length} completed
                    </summary>
                    <ul className="mt-1.5 space-y-1 pl-3">
                      {doneTasks.map((t) => (
                        <li key={t.id} className="line-through opacity-70">
                          {t.title} ·{" "}
                          {t.completed_at &&
                            new Date(t.completed_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: IST_TZ })}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>
  );
}
