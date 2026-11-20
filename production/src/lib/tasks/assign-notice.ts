/**
 * R-2925 — what the new owner of a task is told (bell + email), as plain functions.
 * The reads and the sending live in assign-notice.server.ts.
 */

export interface AssignedTask {
  id: string;
  title: string;
  notes: string | null;
  due_at: string;
  owner_id: string | null;
  /** Who handed it to the owner, and when (set by the save that changed the owner). */
  delegated_by?: string | null;
  delegated_at?: string | null;
  lead_id: string | null;
  quote_id: string | null;
  customer_id: string | null;
  subscription_id: string | null;
}

/** Opens that task — the same path the team-chat task notice uses (R-2304). */
export function taskAppPath(taskId: string): string {
  return `/tasks?tab=all&task=${taskId}`;
}

const DUE_FMT = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric",
  hour: "numeric", minute: "2-digit", hour12: true,
});

/** "19 Nov 2026, 3:30 pm" — always IST, whatever the server's time zone. */
export function formatDueIST(iso: string): string {
  return DUE_FMT.format(new Date(iso));
}

/** A notice is only sent for a hand-over made in the last few minutes (the dialog calls right after the save). */
export const ASSIGN_NOTICE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Why no notice goes for this task — null when one should.
 * "not your assignment": only the person who handed the task over (tasks.delegated_by), and only
 * right after doing it, can have the owner told — so nobody can send "New task from me" mails
 * about a task they did not assign. "already told": this hand-over already has its notice.
 */
export function whyNoNotice(input: {
  task: Pick<AssignedTask, "owner_id" | "delegated_by" | "delegated_at">;
  actorId: string;
  assignee: { id: string; is_active: boolean | null } | null;
  /** created_at of the newest task.assigned notice this owner has for this task. */
  lastToldAt: string | null;
  now?: number;
}): "no owner" | "own task" | "not your assignment" | "owner not in this company" | "already told" | null {
  if (!input.task.owner_id) return "no owner";
  if (input.task.owner_id === input.actorId) return "own task";
  const at = input.task.delegated_at ? Date.parse(input.task.delegated_at) : NaN;
  const age = (input.now ?? Date.now()) - at;
  if (input.task.delegated_by !== input.actorId || !(age <= ASSIGN_NOTICE_WINDOW_MS)) return "not your assignment";
  if (!input.assignee || input.assignee.is_active === false) return "owner not in this company";
  if (input.lastToldAt && Date.parse(input.lastToldAt) >= at) return "already told";
  return null;
}

export interface TaskRelated { label: "Lead" | "Deal" | "Customer" | "Subscription"; name: string; path: string }

/** The record the task is about, with its page. A task has at most one link. */
export function relatedOf(
  task: Pick<AssignedTask, "lead_id" | "quote_id" | "customer_id" | "subscription_id">,
  names: { lead?: string | null; quote?: string | null; customer?: string | null },
): TaskRelated | null {
  if (task.lead_id) return { label: "Lead", name: names.lead?.trim() || "Lead", path: `/leads?lead=${task.lead_id}` };
  if (task.quote_id) return { label: "Deal", name: names.quote?.trim() || task.quote_id, path: `/quotes/${task.quote_id}` };
  if (task.customer_id) return { label: "Customer", name: names.customer?.trim() || "Customer", path: `/customers/${task.customer_id}` };
  // Same page the task row opens for a subscription task (renewal / service auto tasks).
  if (task.subscription_id) return { label: "Subscription", name: "Subscriptions", path: "/subscriptions" };
  return null;
}

/** `canOpenTasks`: false for a role that cannot open the Tasks page (accountant, billing…) — the notice then opens the dashboard. */
export function assignNotification(input: {
  task: Pick<AssignedTask, "id" | "title" | "due_at">; actorName: string; canOpenTasks?: boolean;
}) {
  return {
    kind: "task.assigned" as const,
    title: `New task from ${input.actorName}: ${input.task.title}`,
    body: `Due ${formatDueIST(input.task.due_at)}`,
    href: input.canOpenTasks === false ? "/dashboard" : taskAppPath(input.task.id),
    entityId: input.task.id,
  };
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

export function assignEmail(input: {
  task: Pick<AssignedTask, "id" | "title" | "notes" | "due_at">;
  assigneeName: string;
  actorName: string;
  companyName: string;
  baseUrl: string;
  related: TaskRelated | null;
  /** false for a role that cannot open the Tasks page: the mail then links the app, not a page they would be refused. */
  canOpenTasks?: boolean;
  /** R-2928: the same mail with other opening words (a reminder). Default = "gave you a task". */
  wording?: { subject: string; intro: string };
}): { subject: string; text: string; html: string } {
  const intro = input.wording?.intro ?? `${input.actorName} gave you a task in ${input.companyName}.`;
  const base = input.baseUrl.replace(/\/$/, "");
  const open = input.canOpenTasks !== false;
  const taskUrl = open ? `${base}${taskAppPath(input.task.id)}` : `${base}/dashboard`;
  const openLabel = open ? "Open the task" : "Open the app";
  const due = formatDueIST(input.task.due_at);
  const notes = input.task.notes?.trim() || "";
  const rel = input.related ? { ...input.related, url: `${base}${input.related.path}` } : null;

  const text = [
    `Hi ${input.assigneeName},`,
    "",
    intro,
    "",
    `Task: ${input.task.title}`,
    `Due: ${due}`,
    ...(rel ? [`${rel.label}: ${rel.name} — ${rel.url}`] : []),
    ...(notes ? ["", "Notes:", notes] : []),
    "",
    `${openLabel}: ${taskUrl}`,
  ].join("\n");

  const row = (k: string, v: string) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#667085;vertical-align:top">${k}</td><td style="padding:4px 0">${v}</td></tr>`;
  const html = [
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1d2433;line-height:1.5">`,
    `<p>Hi ${esc(input.assigneeName)},</p>`,
    `<p>${esc(intro)}</p>`,
    `<table style="border-collapse:collapse">`,
    row("Task", `<strong>${esc(input.task.title)}</strong>`),
    row("Due", esc(due)),
    ...(rel ? [row(rel.label, `<a href="${esc(rel.url)}">${esc(rel.name)}</a>`)] : []),
    ...(notes ? [row("Notes", esc(notes).replace(/\n/g, "<br>"))] : []),
    `</table>`,
    `<p><a href="${esc(taskUrl)}" style="display:inline-block;padding:8px 14px;background:#4f46e5;color:#ffffff;text-decoration:none;border-radius:6px">${openLabel}</a></p>`,
    `</div>`,
  ].join("");

  return { subject: input.wording?.subject ?? `New task: ${input.task.title}`, text, html };
}
