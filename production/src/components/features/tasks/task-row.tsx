/**
 * One task on /tasks (R-354): one-click done (optimistic, 5-second Undo in the toast),
 * whom it is about with call / WhatsApp / copy-email right on the row, and edit / snooze /
 * delete. Moved out of app/(app)/tasks/page.tsx.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { toast } from "sonner";
import { useCompleteTask, useSnoozeTask, useDeleteTask, type TaskWithLink } from "@/lib/queries/tasks";
import { memberLabel, type TeamMember } from "@/lib/queries/team";
import { Button, IconButton } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { IST_TZ } from "@/lib/dates/ist";
import { toastError } from "@/lib/errors/toast-error";
import type { TaskKind } from "@/lib/supabase/database.types";
import { leadTitle } from "@/lib/leads/display-name";
import { taskContact } from "./task-contact";

/** R-279: the linked lead's company, else its contact/email/phone; null when it has no name at all. */
export function taskLeadName(task: TaskWithLink): string | null {
  if (!task.leads) return null;
  const t = leadTitle(task.leads);
  return t.source === "none" ? null : t.label;
}

export const KIND_META: Record<TaskKind, { icon: string; label: string }> = {
  call:     { icon: "📞", label: "Call" },
  email:    { icon: "✉️", label: "Email" },
  meeting:  { icon: "📅", label: "Meeting" },
  followup: { icon: "🔁", label: "Follow-up" },
  custom:   { icon: "📋", label: "Task" },
};

const contactBtn =
  "inline-flex items-center justify-center h-8 min-w-8 px-2 rounded-md border border-hairline text-ink-2 hover:bg-paper-2 hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber";

export function TaskRow({ task, onEdit, assignee }: { task: TaskWithLink; onEdit: (t: TaskWithLink) => void; assignee?: TeamMember | null }) {
  const completeTask = useCompleteTask();
  const snoozeTask   = useSnoozeTask();
  const deleteTask   = useDeleteTask();
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const due = new Date(task.due_at);
  const isDone    = task.status === "done";
  const isOverdue = !isDone && due.getTime() < Date.now();
  const kindMeta  = KIND_META[task.kind];
  const contact   = taskContact(task);

  // Linked entity — for the "open" link. At most one of these is set.
  const linkHref =
      task.lead_id         ? `/leads?lead=${task.lead_id}`
    : task.quote_id        ? `/quotes/${task.quote_id}`
    : task.customer_id     ? `/customers/${task.customer_id}`
    : task.subscription_id ? `/subscriptions`
    : null;
  const relatedName =
      taskLeadName(task)         ?? task.customers?.name
    ?? task.quotes?.customer_name ?? null;
  const linkLabel =
      relatedName
    ?? (task.lead_id         ? "Open lead"
      : task.quote_id        ? "Open quote"
      : task.customer_id     ? "Open customer"
      : task.subscription_id ? "Open subscription"
      : null);

  const copyEmail = async (email: string) => {
    try {
      await navigator.clipboard.writeText(email);
      toast.success("Email copied");
    } catch (err) {
      toastError(err, { fallback: "Couldn't copy the email." });
    }
  };

  return (
    <li
      className={cn(
        "px-3 sm:px-4 py-3 flex items-start gap-2 sm:gap-3 transition-colors",
        isOverdue && "bg-rose-soft/30",
        isDone    && "opacity-60",
      )}
    >
      {/* One click = done. The hit area is 36px; the visible circle stays small. */}
      <button
        type="button"
        role="checkbox"
        aria-checked={isDone}
        onClick={() => { if (!isDone && !completeTask.isPending) completeTask.mutate(task.id); }}
        disabled={isDone}
        title={isDone ? "Completed" : "Mark done"}
        aria-label={isDone ? `Completed: ${task.title}` : `Mark done: ${task.title}`}
        className="-ml-1.5 -mt-0.5 h-9 w-9 shrink-0 flex items-center justify-center rounded-full group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
      >
        <span
          className={cn(
            "w-5 h-5 rounded-full border flex items-center justify-center transition-colors",
            isDone
              ? "bg-emerald border-emerald text-paper"
              : "border-hairline-strong group-hover:bg-emerald-soft group-hover:border-emerald",
          )}
        >
          {isDone && <Icon name="check" size={12} />}
        </span>
      </button>

      {/* Body */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base leading-none" aria-hidden="true">{kindMeta.icon}</span>
          <p className={cn("font-medium text-ink break-words min-w-0", isDone && "line-through")}>{task.title}</p>
          <Badge kind="muted">{kindMeta.label}</Badge>
          {assignee && (
            <span className="inline-flex items-center gap-1 rounded-full bg-indigo-soft/60 text-indigo px-2 py-0.5 text-2xs font-medium" title={`Assigned to ${memberLabel(assignee)}`}>
              <Icon name="user" size={10} /> {memberLabel(assignee)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-x-3 gap-y-1 mt-1 text-[12px] flex-wrap">
          <span className={cn(
            "tabular-nums",
            isOverdue ? "text-rose font-medium" :
            isDone    ? "text-ink-3" :
                        "text-ink-2",
          )}>
            {isOverdue && "⚠ Overdue · "}
            {due.toLocaleString("en-IN", {
              weekday: "short", day: "numeric", month: "short",
              hour: "2-digit", minute: "2-digit", timeZone: IST_TZ,
            })}
          </span>
          {task.snooze_count > 0 && (
            <span className="text-ink-3 text-2xs">snoozed {task.snooze_count}×</span>
          )}
          {linkHref && linkLabel && (
            <Link
              href={linkHref as Route}
              className="text-amber-ink hover:underline text-2xs inline-flex items-center gap-0.5 min-w-0"
            >
              <Icon name="external" size={10} /> <span className="truncate max-w-[16rem]">{linkLabel}</span>
            </Link>
          )}
        </div>

        {/* Whom to reach — straight from the linked lead / customer. */}
        {contact && !isDone && (
          <div className="mt-2 flex items-center gap-1.5 flex-wrap text-[12px]">
            {contact.person && contact.person !== relatedName && (
              <span className="text-ink-2 inline-flex items-center gap-1 mr-1">
                <Icon name="user" size={11} /> {contact.person}
              </span>
            )}
            {contact.phone && (
              <span className="tabular-nums text-ink-2 mr-0.5">{contact.phone}</span>
            )}
            {contact.telHref && (
              <a href={contact.telHref} className={contactBtn} aria-label={`Call ${contact.phone}`} title="Call">
                <Icon name="phone" size={13} />
              </a>
            )}
            {contact.whatsappHref && (
              <a href={contact.whatsappHref} target="_blank" rel="noopener noreferrer" className={contactBtn} aria-label={`WhatsApp ${contact.phone}`} title="WhatsApp">
                <Icon name="whatsapp" size={13} />
              </a>
            )}
            {contact.email && (
              <>
                <a href={`mailto:${contact.email}`} className="text-ink-2 hover:text-ink hover:underline truncate max-w-[14rem] ml-1">
                  {contact.email}
                </a>
                <button type="button" onClick={() => void copyEmail(contact.email!)} className={contactBtn} aria-label={`Copy email ${contact.email}`} title="Copy email">
                  <Icon name="copy" size={13} />
                </button>
              </>
            )}
          </div>
        )}

        {task.notes && (
          <p className="text-[12px] text-ink-3 mt-1.5 whitespace-pre-line">{task.notes}</p>
        )}
      </div>

      {/* Actions */}
      {!isDone && (
        <div className="flex gap-0.5 shrink-0">
          <IconButton icon="edit" size="sm" variant="ghost" aria-label="Edit task" title="Edit task" onClick={() => onEdit(task)} />
          <IconButton icon="clock" size="sm" variant="ghost" aria-label="Snooze 1 day" title="Snooze 1 day" onClick={() => snoozeTask.mutate({ id: task.id })} />
          <IconButton icon="trash" size="sm" variant="ghost" aria-label="Delete" title="Delete" onClick={() => setConfirmOpen(true)} />
        </div>
      )}

      {/* Delete confirmation — an in-app dialog (native window.confirm is suppressed in some
          browsers/embeds and always returns false, which made delete silently fail). */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Icon name="trash" size={18} className="text-rose" />
              Delete this task?
            </DialogTitle>
            <DialogDescription>
              &ldquo;{task.title}&rdquo; will be deleted for good. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button
              type="button"
              variant="danger"
              icon="trash"
              loading={deleteTask.isPending}
              onClick={() => deleteTask.mutate(task.id, { onSuccess: () => setConfirmOpen(false) })}
            >
              Delete task
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}
