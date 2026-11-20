/**
 * One task on /tasks (R-354): one-click done (optimistic, 5-second Undo in the toast),
 * whom it is about with call / WhatsApp / copy-email right on the row, and edit / snooze /
 * delete. Moved out of app/(app)/tasks/page.tsx.
 *
 * R-2937: two layouts of the same row. "compact" (the /tasks list's default) is ONE line — done circle,
 * name, whom it is about, people, priority, status, due in words ("Overdue by 3 days"),
 * actions — and a click on the name opens the rest (notes, contact, full date) under it.
 * "comfortable" is the earlier card with everything showing. Both use the same saves, the same
 * buttons and the same test ids; only the arrangement differs.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { toast } from "sonner";
import { useCompleteTask, useDeleteTask, useReopenTask, useSetTaskProgress, type TaskWithLink } from "@/lib/queries/tasks";
import { rowStatusChange, type TaskRowStatus } from "./task-progress";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { snoozeChoices, useSnoozeTaskTo } from "./task-snooze";
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
import { TaskNotes, taskNoteParts } from "./task-notes";
import { TaskStatusMenu } from "./task-status-menu";
import { TASK_PRIORITY_META, priorityOf, showsPriorityBadge } from "./task-priority";
import { canRemind, lastRemindedLabel, useRemindTask } from "./task-remind";
import { Avatar } from "@/components/ui/avatar";
import { safeTaskLink, taskLinkLabel } from "@/lib/tasks/collaborators";
import { taskDueWords } from "./task-due-words";
import type { TaskDensity } from "./task-view-pref";

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

export function TaskRow({ task, onEdit, assignee, meId, collaborators, density = "comfortable", now }: {
  task: TaskWithLink; onEdit: (t: TaskWithLink) => void; assignee?: TeamMember | null;
  /** R-2933: the teammates working on this task with its owner (up to 3). */
  collaborators?: readonly TeamMember[];
  /** R-2928: who is looking — "Remind" shows only on someone else's task. Not given = no button. */
  meId?: string | null;
  /** R-2937: "compact" = one line (what the /tasks list asks for by default); not given = the roomy card, as before. */
  density?: TaskDensity;
  /** R-2937: the page's clock (it ticks once a minute) so the due words stay true. Not given = now. */
  now?: Date;
}) {
  const completeTask = useCompleteTask();
  const reopenTask   = useReopenTask();
  const setProgress  = useSetTaskProgress();
  /* One guard for the circle AND the status menu: a second status change waits for the first. */
  const statusBusy   = completeTask.isPending || reopenTask.isPending || setProgress.isPending;
  const pickStatus = (next: TaskRowStatus) => {
    const change = rowStatusChange(task, next);
    if (!change || statusBusy) return;
    if (change.complete) completeTask.mutate(task.id);
    else if (change.progress) setProgress.mutate({ id: task.id, progress: change.progress, reopen: !!change.reopen });
  };
  const snoozeTask   = useSnoozeTaskTo();
  const deleteTask   = useDeleteTask();
  const remindTask   = useRemindTask();
  const lastReminded = lastRemindedLabel(task.last_followup_at);
  const taskLink     = safeTaskLink(task.link_url);
  const withNames    = (collaborators ?? []).map((m) => memberLabel(m));
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [detailOpen, setDetailOpen] = React.useState(false); // compact: the rest of the task, under its line
  const detailId = React.useId();

  const due = new Date(task.due_at);
  const clock     = now ?? new Date();
  const isDone    = task.status === "done";
  const isOverdue = !isDone && due.getTime() < clock.getTime();
  const compact   = density === "compact";
  const kindMeta  = KIND_META[task.kind];
  const priority  = priorityOf(task);
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

  /* ── The pieces both layouts share ─────────────────────────────────────────────────── */

  /* One click = done; R-1416: one click on a ticked circle = not done again (it was
     disabled, so a Done task could never be reopened). The hit area is 36px (28px on the
     one-line row from xl up, where a mouse is used); the visible circle stays small. */
  const doneCircle = (
    <button
      type="button"
      role="checkbox"
      aria-checked={isDone}
      onClick={() => {
        if (statusBusy) return;
        if (isDone) reopenTask.mutate(task.id);
        else completeTask.mutate(task.id);
      }}
      title={isDone ? "Mark not done" : "Mark done"}
      aria-label={isDone ? `Mark not done: ${task.title}` : `Mark done: ${task.title}`}
      className={cn(
        "-ml-1.5 shrink-0 flex items-center justify-center rounded-full group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber",
        compact ? "h-9 w-9 xl:h-7 xl:w-7" : "-mt-0.5 h-9 w-9",
      )}
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
  );

  /* R-2927: Not started / In progress / On hold / Done — change it right here. */
  const statusMenu = <TaskStatusMenu task={task} busy={statusBusy} onPick={pickStatus} />;

  /* R-2926: priority — colour AND word, for High and Low (Medium is the default: no badge). Hidden once done. */
  const priorityBadge = !isDone && showsPriorityBadge(priority) ? (
    <Badge kind={TASK_PRIORITY_META[priority].badge} title={`Priority: ${TASK_PRIORITY_META[priority].label}`}>
      {TASK_PRIORITY_META[priority].label}
    </Badge>
  ) : null;

  /* R-2933: who works on it with the owner — small avatars, names on hover and for screen readers. */
  const workingWith = (lead: string) => withNames.length > 0 ? (
    <span
      className="inline-flex items-center gap-1 text-2xs text-ink-3"
      data-testid="task-collaborators"
      title={`Working with ${withNames.join(", ")}`}
    >
      <span aria-hidden="true">{lead}</span>
      <span className="sr-only">Working with {withNames.join(", ")}</span>
      <span className="inline-flex -space-x-1" aria-hidden="true">
        {(collaborators ?? []).map((m) => (
          <Avatar key={m.id} size="xs" name={memberLabel(m)} initials={m.initials ?? undefined} className="ring-1 ring-paper" />
        ))}
      </span>
    </span>
  ) : null;

  /* Whom to reach — straight from the linked lead / customer. */
  const contactBlock = contact && !isDone ? (
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
  ) : null;

  const actions = !isDone ? (
    <div className="flex gap-0.5 shrink-0">
      {/* R-2928: nudge the teammate who has this task (bell + email; once an hour per task). */}
      {canRemind(task, meId) && (
        <IconButton
          icon="bell" size="sm" variant="ghost"
          aria-label={`Remind${assignee ? ` ${memberLabel(assignee)}` : ""}: ${task.title}`}
          title={assignee ? `Remind ${memberLabel(assignee)}` : "Remind"}
          disabled={remindTask.isPending}
          onClick={() => remindTask.mutate(task.id)}
        />
      )}
      <IconButton icon="edit" size="sm" variant="ghost" aria-label="Edit task" title="Edit task" onClick={() => onEdit(task)} />
      {/* R-471: Snooze offers choices (was a blind +1 day from the old due time). */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <IconButton icon="clock" size="sm" variant="ghost" aria-label="Snooze" title="Snooze" disabled={snoozeTask.isPending} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[200px]">
          <DropdownMenuLabel>Snooze until</DropdownMenuLabel>
          {snoozeChoices().map((c) => (
            <DropdownMenuItem key={c.key} onSelect={() => snoozeTask.mutate({ id: task.id, at: c.at, snoozeCount: task.snooze_count ?? 0 })}>
              {c.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onEdit(task)}>Pick a date…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <IconButton icon="trash" size="sm" variant="ghost" aria-label="Delete" title="Delete" onClick={() => setConfirmOpen(true)} />
    </div>
  ) : null;

  /* Delete confirmation — an in-app dialog (native window.confirm is suppressed in some
     browsers/embeds and always returns false, which made delete silently fail). */
  const deleteDialog = (
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
  );

  /* ── R-2937: one line ──────────────────────────────────────────────────────────────── */
  if (compact) {
    const dueWords = taskDueWords(task, clock);
    const { text: noteText, chatHref } = taskNoteParts(task.notes);
    /* Small icon links on the line: 36px to touch on a phone, 24px with a mouse. */
    const iconLink = "shrink-0 inline-flex items-center justify-center h-9 w-9 xl:h-6 xl:w-6 rounded text-amber-ink hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber";
    return (
      <li
        data-density="compact"
        /* scroll-mt: a row brought into view by Tab is not left under the top bar + stuck heading. */
        className={cn("scroll-mt-24 px-3 transition-colors", isOverdue && "bg-rose-soft/30", isDone && "opacity-60")}
      >
        {/* From xl (1280) up everything sits on ONE line in fixed columns, so the list reads like
            a table and the name keeps the rest of the width. Narrower than that the columns
            wrap under the name instead of squeezing it. */}
        {/* R-2942: on one line the columns sit 6px apart (8px when wrapped) — 14px more for the name. */}
        <div className="flex items-center gap-x-2 xl:gap-x-1.5 gap-y-0.5 flex-wrap xl:flex-nowrap min-h-[30px] py-1 xl:py-0">
          {doneCircle}

          {/* Name — a click opens the rest of the task under the line. */}
          <div className="flex items-center gap-1.5 min-w-0 flex-1 basis-[70%] xl:basis-0">
            {/* R-2942: the hover text names the type — from 1280 to 1535 px its word is off the line. */}
            <span className="text-sm leading-none shrink-0" aria-hidden="true" title={kindMeta.label}>{kindMeta.icon}</span>
            <button
              type="button"
              onClick={() => setDetailOpen((o) => !o)}
              aria-expanded={detailOpen}
              aria-controls={detailOpen ? detailId : undefined}
              title={noteText ? `${task.title}\n\n${noteText}` : task.title}
              className={cn(
                "min-w-0 min-h-9 xl:min-h-0 text-left text-sm font-medium text-ink rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber",
                /* R-2942: opened, a name too long for the line wraps and shows in full. */
                detailOpen ? "whitespace-normal break-words py-1" : "truncate",
                isDone && "line-through",
              )}
            >
              {task.title}
            </button>
            {/* R-2942: at 1280 the name was cut ("Set up seats (DNS, users) · T…") with this word
                beside it. From xl to 2xl the icon alone says the type (the word is still read out);
                on a wider screen, and on the wrapped phone layout, the word shows. */}
            <span className="shrink-0 text-2xs text-ink-3 xl:sr-only 2xl:not-sr-only">{kindMeta.label}</span>
            {noteText && <Icon name="message" size={11} className="shrink-0 text-ink-3" aria-hidden="true" />}
            {/* R-2933: the task's link (Drive file, doc, page) opens in a new tab. */}
            {taskLink && (
              <a
                href={taskLink} target="_blank" rel="noopener noreferrer"
                className={iconLink}
                aria-label={`Open link: ${taskLinkLabel(taskLink)}`}
                title={`Open link: ${taskLinkLabel(taskLink)}`}
                data-testid="task-link"
              >
                <Icon name="link" size={12} /> <span className="sr-only">{taskLinkLabel(taskLink)}</span>
              </a>
            )}
            {/* R-2327: a task made from Team chat opens that message — on the line, one click. */}
            {chatHref && (
              <Link href={chatHref as Route} title="Open in team chat" className={iconLink}>
                <Icon name="chat" size={12} aria-hidden="true" /> <span className="sr-only">Open in team chat</span>
              </Link>
            )}
            {/* R-2928: when the owner of this task was last reminded (the words are in the opened row). */}
            {lastReminded && !isDone && (
              <span className="shrink-0 inline-flex items-center text-ink-3" title={lastReminded} data-testid="task-last-reminded">
                <Icon name="bell" size={11} aria-hidden="true" /> <span className="sr-only">{lastReminded}</span>
              </span>
            )}
          </div>

          {/* Whom it is about. */}
          {linkHref && linkLabel && (
            <Link
              href={linkHref as Route}
              title={linkLabel}
              className="shrink min-w-0 max-w-[9rem] inline-flex items-center gap-1 rounded-full border border-hairline px-2 py-0.5 text-2xs text-amber-ink hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
            >
              <Icon name="external" size={10} className="shrink-0" /> <span className="truncate">{linkLabel}</span>
            </Link>
          )}

          {/* Who has it (+ who works with them, R-2933). */}
          <div className="flex items-center gap-1 shrink-0 xl:w-[84px]">
            {assignee && (
              <span title={`Assigned to ${memberLabel(assignee)}`} className="inline-flex">
                <Avatar size="xs" color="indigo" name={memberLabel(assignee)} initials={assignee.initials ?? undefined} />
                <span className="sr-only">Assigned to {memberLabel(assignee)}</span>
              </span>
            )}
            {workingWith("+")}
          </div>

          <div className="flex items-center shrink-0 xl:w-[52px]">{priorityBadge}</div>
          <div className="flex items-center shrink-0 xl:w-[100px]">{statusMenu}</div>

          {/* The hover text repeats the words, so a cut-off "Overdue by 120 days" can still be read. */}
          <span
            title={`${dueWords.text} — ${dueWords.full}`}
            className={cn(
              /* R-2942: 124px holds "Overdue by 120 days" (measured 122px); the 8px saved go to the name. */
              "shrink-0 xl:w-[124px] truncate text-xs tabular-nums",
              dueWords.tone === "overdue" ? "text-rose-ink font-medium" :
              dueWords.tone === "done"    ? "text-ink-3" :
                                            "text-ink-2",
            )}
          >
            {dueWords.text}
          </span>

          <div className="flex justify-end shrink-0 ml-auto xl:ml-0 xl:w-[120px]">{actions}</div>
        </div>

        {detailOpen && (
          <div id={detailId} className="pb-2.5 pl-8 xl:pl-7 text-[12px]">
            <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-ink-2">
              <span className="tabular-nums">{dueWords.full}</span>
              {task.snooze_count > 0 && <span className="text-ink-3">snoozed {task.snooze_count}×</span>}
              {lastReminded && !isDone && <span className="text-ink-3">{lastReminded}</span>}
            </div>
            {contactBlock}
            {/* The notes' text; its Team chat link is already on the line above. */}
            {noteText && <p className="mt-1.5 text-ink-3 whitespace-pre-line">{noteText}</p>}
          </div>
        )}

        {deleteDialog}
      </li>
    );
  }

  /* ── Comfortable: the roomy card ───────────────────────────────────────────────────── */
  return (
    <li
      data-density="comfortable"
      className={cn(
        "scroll-mt-24 px-3 sm:px-4 py-3 flex items-start gap-2 sm:gap-3 transition-colors",
        isOverdue && "bg-rose-soft/30",
        isDone    && "opacity-60",
      )}
    >
      {doneCircle}

      {/* Body */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base leading-none" aria-hidden="true">{kindMeta.icon}</span>
          <p className={cn("font-medium text-ink break-words min-w-0", isDone && "line-through")}>{task.title}</p>
          <Badge kind="muted">{kindMeta.label}</Badge>
          {statusMenu}
          {priorityBadge}
          {assignee && (
            <span className="inline-flex items-center gap-1 rounded-full bg-indigo-soft/60 text-indigo px-2 py-0.5 text-2xs font-medium" title={`Assigned to ${memberLabel(assignee)}`}>
              <Icon name="user" size={10} /> {memberLabel(assignee)}
            </span>
          )}
          {workingWith("with")}
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
          {/* R-2928: when the owner of this task was last reminded. */}
          {lastReminded && !isDone && (
            <span className="text-ink-3 text-2xs inline-flex items-center gap-0.5" data-testid="task-last-reminded">
              <Icon name="bell" size={10} /> {lastReminded}
            </span>
          )}
          {/* R-2933: the task's link (Drive file, doc, page) opens in a new tab. */}
          {taskLink && (
            <a
              href={taskLink} target="_blank" rel="noopener noreferrer"
              className="text-amber-ink hover:underline text-2xs inline-flex items-center gap-0.5 min-w-0"
              aria-label={`Open link: ${taskLinkLabel(taskLink)}`}
              data-testid="task-link"
            >
              <Icon name="link" size={10} /> <span className="truncate max-w-[12rem]">{taskLinkLabel(taskLink)}</span>
            </a>
          )}
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

        {contactBlock}

        {/* R-2327: the "From team chat: …" line shows as an "Open in team chat" link. */}
        <TaskNotes notes={task.notes} />
      </div>

      {actions}
      {deleteDialog}
    </li>
  );
}
