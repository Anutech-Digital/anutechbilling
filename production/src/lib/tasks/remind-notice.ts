/**
 * R-2928 — "Remind" on a teammate's task: the rules and what the owner of the task reads, as
 * plain functions. The reads, the stamp and the sending live in remind-notice.server.ts.
 * The bell line and the email reuse the pieces of the "task given to you" notice (R-2925).
 */
import { assignEmail, formatDueIST, taskAppPath, type AssignedTask, type TaskRelated } from "./assign-notice";

/** One reminder per task per hour — so a row cannot be used to flood a teammate's inbox. */
export const REMIND_GAP_MS = 60 * 60 * 1000;

export type NoReminderReason =
  | "no owner" | "own task" | "task is closed" | "owner not in this company" | "reminded recently";

/** Why no reminder goes for this task — null when one should. */
export function whyNoReminder(input: {
  task: { status: string; owner_id: string | null; last_followup_at?: string | null };
  actorId: string;
  assignee: { id: string; is_active: boolean | null } | null;
  now?: number;
}): NoReminderReason | null {
  const { task } = input;
  if (task.status === "done" || task.status === "cancelled") return "task is closed";
  if (!task.owner_id) return "no owner";
  if (task.owner_id === input.actorId) return "own task";
  if (!input.assignee || input.assignee.is_active === false) return "owner not in this company";
  const last = task.last_followup_at ? Date.parse(task.last_followup_at) : NaN;
  if (Number.isFinite(last) && (input.now ?? Date.now()) - last < REMIND_GAP_MS) return "reminded recently";
  return null;
}

/** R-2941: the bell notice could not be written — nothing was sent and the hour was given back. */
export const NOTICE_NOT_SENT = "notice not sent";

/** What the person who pressed Remind reads when nothing was sent (§24: what happened + what now). */
export function noReminderMessage(reason: NoReminderReason | "task not found" | typeof NOTICE_NOT_SENT, lastFollowupAt?: string | null): string {
  switch (reason) {
    case "reminded recently": {
      const next = lastFollowupAt ? formatDueIST(new Date(Date.parse(lastFollowupAt) + REMIND_GAP_MS).toISOString()) : null;
      return next
        ? `A reminder was already sent for this task in the last hour — you can remind again after ${next}.`
        : "A reminder was already sent for this task in the last hour — try again later.";
    }
    case "own task": return "This is your own task — a reminder goes only to a teammate.";
    case "no owner": return "This task is not assigned to anyone — assign it first (Edit task).";
    case "task is closed": return "This task is already done — there is nothing to remind about.";
    case "owner not in this company": return "The person this task is assigned to is no longer active — assign it to someone else (Edit task).";
    case "task not found": return "This task no longer exists — refresh the page.";
    case NOTICE_NOT_SENT: return "The reminder could not be sent just now — nothing went out. Press Remind again.";
  }
}

/** `canOpenTasks`: false for a role that cannot open the Tasks page — the notice then opens the dashboard. */
export function remindNotification(input: {
  task: Pick<AssignedTask, "id" | "title" | "due_at">; actorName: string; canOpenTasks?: boolean;
}) {
  return {
    kind: "task.reminder" as const,
    title: `Reminder from ${input.actorName}: ${input.task.title}`,
    body: `Due ${formatDueIST(input.task.due_at)}`,
    href: input.canOpenTasks === false ? "/dashboard" : taskAppPath(input.task.id),
    entityId: input.task.id,
  };
}

/** The "task given to you" mail with reminder wording — same details, same link. */
export function remindEmail(input: {
  task: Pick<AssignedTask, "id" | "title" | "notes" | "due_at">;
  assigneeName: string;
  actorName: string;
  companyName: string;
  baseUrl: string;
  related: TaskRelated | null;
  canOpenTasks?: boolean;
}): { subject: string; text: string; html: string } {
  return assignEmail({
    ...input,
    wording: {
      subject: `Reminder: ${input.task.title}`,
      intro: `${input.actorName} sent you a reminder about this task in ${input.companyName}.`,
    },
  });
}
