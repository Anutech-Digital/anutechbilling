/**
 * R-2933 — people working WITH a task's owner (up to 3) and the task's link, as plain functions.
 * The reads, writes and notices live in collaborators.server.ts (POST /api/tasks/collaborators).
 */
import { assignEmail, formatDueIST, taskAppPath, type AssignedTask, type TaskRelated } from "./assign-notice";

/** A task has one owner and up to this many people working with them. */
export const MAX_TASK_COLLABORATORS = 3;

export const TOO_MANY_COLLABORATORS =
  `A task can have up to ${MAX_TASK_COLLABORATORS} people working with its owner — remove one to add another.`;

/** A person picked who is not (any more) an active member of this company. */
export const NOT_AN_ACTIVE_MEMBER =
  "One of the people picked is not an active member of your team — refresh the page and pick again.";

/**
 * The list to save: no blanks, nobody twice, never the task's owner (they already have the task),
 * only active members of this company. More than the limit is an error, not a silent cut.
 */
export function cleanCollaborators(input: {
  userIds: readonly string[];
  ownerId: string | null | undefined;
  activeMemberIds: ReadonlySet<string>;
}): { ok: true; userIds: string[] } | { ok: false; error: string } {
  const seen = new Set<string>();
  for (const raw of input.userIds) {
    const id = raw?.trim();
    if (!id || id === input.ownerId) continue;
    if (!input.activeMemberIds.has(id)) return { ok: false, error: NOT_AN_ACTIVE_MEMBER };
    seen.add(id);
  }
  if (seen.size > MAX_TASK_COLLABORATORS) return { ok: false, error: TOO_MANY_COLLABORATORS };
  return { ok: true, userIds: [...seen] };
}

/** Who to add and who to remove to get from `current` to `next`. */
export function collaboratorDiff(current: readonly string[], next: readonly string[]): { add: string[]; remove: string[] } {
  const cur = new Set(current), nxt = new Set(next);
  return { add: [...nxt].filter((id) => !cur.has(id)), remove: [...cur].filter((id) => !nxt.has(id)) };
}

/** Same people, any order? */
export function sameCollaborators(a: readonly string[], b: readonly string[]): boolean {
  const d = collaboratorDiff(a, b);
  return d.add.length === 0 && d.remove.length === 0;
}

/** Toggle one person in the dialog's selection; a 4th person is not added (`full`). */
export function toggleCollaborator(selected: readonly string[], id: string): { selected: string[]; full: boolean } {
  if (selected.includes(id)) return { selected: selected.filter((x) => x !== id), full: false };
  if (selected.length >= MAX_TASK_COLLABORATORS) return { selected: [...selected], full: true };
  return { selected: [...selected, id], full: false };
}

export const TASK_LINK_MAX = 2000;

/**
 * The task's link as typed → what is saved. Blank = no link. "drive.google.com/x" gets https://.
 * Only http(s) web addresses are kept — never javascript:, data:, file: — because the row opens it.
 */
export function normalizeTaskLink(input: string | null | undefined): { ok: true; url: string | null } | { ok: false; error: string } {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: true, url: null };
  const bad = { ok: false as const, error: "Enter a web link like https://drive.google.com/… (or leave it empty)." };
  if (raw.length > TASK_LINK_MAX || /\s/.test(raw)) return bad;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let u: URL;
  try { u = new URL(withScheme); } catch { return bad; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return bad;
  if (!u.hostname.includes(".") && u.hostname !== "localhost") return bad;
  return { ok: true, url: u.toString() };
}

/** A saved link is opened only when it is a plain http(s) address (defence for rows written another way). */
export function safeTaskLink(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The site's name for the row ("drive.google.com"). */
export function taskLinkLabel(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "Link"; }
}

/** The bell line for a person added to work with the task's owner. */
export function collaboratorNotification(input: {
  task: Pick<AssignedTask, "id" | "title" | "due_at">; actorName: string; canOpenTasks?: boolean;
}) {
  return {
    kind: "task.assigned" as const,
    title: `${input.actorName} added you to a task: ${input.task.title}`,
    body: `Due ${formatDueIST(input.task.due_at)}`,
    href: input.canOpenTasks === false ? "/dashboard" : taskAppPath(input.task.id),
    entityId: input.task.id,
  };
}

/** The "task given to you" mail with "added you to" wording — same details, same link. */
export function collaboratorEmail(input: {
  task: Pick<AssignedTask, "id" | "title" | "notes" | "due_at">;
  assigneeName: string;
  actorName: string;
  ownerName: string | null;
  companyName: string;
  baseUrl: string;
  related: TaskRelated | null;
  canOpenTasks?: boolean;
}): { subject: string; text: string; html: string } {
  const withOwner = input.ownerName ? ` (owner: ${input.ownerName})` : "";
  return assignEmail({
    ...input,
    wording: {
      subject: `Added to a task: ${input.task.title}`,
      intro: `${input.actorName} added you to work on this task in ${input.companyName}${withOwner}.`,
    },
  });
}
