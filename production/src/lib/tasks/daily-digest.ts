/**
 * R-2929 — the morning task digest: who gets a message, and what it says.
 *
 * Pardeep, 18 Nov 2026 (task-management video audit): nothing reached anybody when a task fell
 * due or went overdue. The cron (app/api/cron/task-digest) sends each person ONE short list a
 * day — their overdue tasks and the ones due today — and the owner ONE team summary.
 *
 * Pure: no database, no clock, no sender. The cron reads, this decides and writes the words.
 *
 * Open tasks: lib/queries/tasks.ts owns TASK_OPEN_STATUSES, but that file is "use client" and a
 * cron route cannot import a value from it. So the cron reads "every status that is not closed"
 * (TASK_CLOSED_STATUSES) — a new open status (in progress, on hold) is in the digest the day it
 * exists, and daily-digest.test.ts fails if an open status is ever put on the closed list.
 */
import { daysBetweenISO, formatIstDate, formatIstTime, toIstDate } from "@/lib/dates/ist";

/** A task with one of these is finished or dropped — never in a digest. */
export const TASK_CLOSED_STATUSES = ["done", "cancelled"] as const;

/** PostgREST list for `.not("status", "in", …)`. */
export function closedStatusFilter(): string {
  return `(${TASK_CLOSED_STATUSES.join(",")})`;
}

/**
 * The approved WhatsApp template a company needs for the WhatsApp copy (Marketing → WhatsApp →
 * Templates). Three body values: {{1}} first name, {{2}} counts, {{3}} task names on one line.
 * No approved template with this name → email only.
 */
export const DIGEST_WA_TEMPLATE = "task_daily_digest";

/**
 * Wording to submit to Meta (UTILITY). Neutral on purpose: the owner's team summary goes through
 * the same template, with the team totals in {{2}} and one line per person in {{3}}. A body may
 * not start or end with a {{n}}. The cron prints this in `whatsapp_note` when the template is missing.
 */
export const DIGEST_WA_TEMPLATE_BODY =
  "Hi {{1}}, task list for today: {{2}}. Details: {{3}}. Open the Tasks page to update them.";

export type DigestKind = "personal" | "owner_summary";

export interface DigestTask {
  id: string;
  owner_id: string | null;
  title: string;
  /** timestamptz, ISO. */
  due_at: string;
}

export interface DigestPerson {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  role: string;
  isActive: boolean;
}

export interface TeamLine { name: string; overdue: number; today: number }
export interface DigestTotals { overdue: number; today: number }

export interface PersonalDigest {
  kind: "personal";
  person: DigestPerson;
  overdue: DigestTask[];
  today: DigestTask[];
}

export interface OwnerSummary {
  kind: "owner_summary";
  person: DigestPerson;
  /** The owner's own tasks. */
  overdue: DigestTask[];
  today: DigestTask[];
  /** Everybody else with something overdue or due today, most overdue first. */
  team: TeamLine[];
  /** The whole company, the owner's own tasks included. */
  totals: DigestTotals;
}

export interface DigestPlan {
  personal: PersonalDigest[];
  ownerSummaries: OwnerSummary[];
  /** People with tasks who get no message, and why. */
  skipped: { userId: string; reason: "inactive" | "no_email" }[];
}

const NOT_ASSIGNED = "Not assigned";
const MAX_LINES = 20;
const MAX_WA_NAMES = 5;
const MAX_WA_VALUE = 600;

const byDue = (a: DigestTask, b: DigestTask) =>
  a.due_at < b.due_at ? -1 : a.due_at > b.due_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * @param today  the IST calendar day the digest is for (YYYY-MM-DD)
 * @param people one company's users
 * @param tasks  that company's OPEN tasks (any due date — later ones are ignored here)
 */
export function planTaskDigests(input: { today: string; people: DigestPerson[]; tasks: DigestTask[] }): DigestPlan {
  const { today, people } = input;
  const known = new Map(people.map((p) => [p.id, p]));
  const buckets = new Map<string | null, { overdue: DigestTask[]; today: DigestTask[] }>();

  for (const t of [...input.tasks].sort(byDue)) {
    const day = toIstDate(t.due_at);
    if (day > today) continue;
    const key = t.owner_id && known.has(t.owner_id) ? t.owner_id : null;
    let b = buckets.get(key);
    if (!b) { b = { overdue: [], today: [] }; buckets.set(key, b); }
    (day < today ? b.overdue : b.today).push(t);
  }

  const plan: DigestPlan = { personal: [], ownerSummaries: [], skipped: [] };
  if (buckets.size === 0) return plan;

  const totals: DigestTotals = { overdue: 0, today: 0 };
  for (const b of buckets.values()) { totals.overdue += b.overdue.length; totals.today += b.today.length; }

  const owners = people.filter((p) => p.role === "owner");

  for (const p of people) {
    if (p.role === "owner") continue;
    const b = buckets.get(p.id);
    if (!b) continue;
    if (!p.isActive) { plan.skipped.push({ userId: p.id, reason: "inactive" }); continue; }
    if (!p.email?.trim()) { plan.skipped.push({ userId: p.id, reason: "no_email" }); continue; }
    plan.personal.push({ kind: "personal", person: p, overdue: b.overdue, today: b.today });
  }

  for (const owner of owners) {
    if (!owner.isActive) continue;
    if (!owner.email?.trim()) { plan.skipped.push({ userId: owner.id, reason: "no_email" }); continue; }
    const own = buckets.get(owner.id) ?? { overdue: [], today: [] };
    const team: TeamLine[] = [];
    for (const [key, b] of buckets) {
      if (key === owner.id) continue;
      const who = key ? known.get(key)! : null;
      const name = !who ? NOT_ASSIGNED : `${who.name?.trim() || who.email || "Team member"}${who.isActive ? "" : " (inactive)"}`;
      team.push({ name, overdue: b.overdue.length, today: b.today.length });
    }
    team.sort((a, z) => z.overdue - a.overdue || z.today - a.today || a.name.localeCompare(z.name));
    plan.ownerSummaries.push({ kind: "owner_summary", person: owner, overdue: own.overdue, today: own.today, team, totals });
  }

  return plan;
}

/* ─── Words ──────────────────────────────────────────────────────────────── */

function firstName(name: string | null | undefined): string | null {
  return name?.trim().split(/\s+/)[0] || null;
}

/** "2 overdue, 1 due today" — a zero part is left out. */
export function countsLine(overdue: number, today: number): string {
  const parts: string[] = [];
  if (overdue > 0) parts.push(`${overdue} overdue`);
  if (today > 0) parts.push(`${today} due today`);
  return parts.join(", ");
}

function capped(lines: string[]): string[] {
  if (lines.length <= MAX_LINES) return lines;
  return [...lines.slice(0, MAX_LINES), `…and ${lines.length - MAX_LINES} more`];
}

function taskBlocks(today: string, overdue: DigestTask[], dueToday: DigestTask[]): string[] {
  const out: string[] = [];
  if (overdue.length > 0) {
    out.push(`Overdue (${overdue.length})`, ...capped(overdue.map((t) => {
      const day = toIstDate(t.due_at);
      const late = daysBetweenISO(day, today);
      return `- ${t.title.trim()} (was due ${formatIstDate(day)}, ${late} day${late === 1 ? "" : "s"} late)`;
    })), "");
  }
  if (dueToday.length > 0) {
    out.push(`Due today (${dueToday.length})`, ...capped(dueToday.map((t) => `- ${t.title.trim()} (${formatIstTime(t.due_at)})`)), "");
  }
  return out;
}

export interface DigestMessage { subject: string; text: string }

export function renderPersonalDigest(input: {
  name: string | null; today: string; tasksUrl: string; overdue: DigestTask[]; dueToday: DigestTask[];
}): DigestMessage {
  const first = firstName(input.name);
  return {
    subject: `Your tasks for ${formatIstDate(input.today)}: ${countsLine(input.overdue.length, input.dueToday.length)}`,
    text: [
      first ? `Hi ${first},` : "Hi,",
      "",
      ...taskBlocks(input.today, input.overdue, input.dueToday),
      `Open your tasks: ${input.tasksUrl}`,
    ].join("\n"),
  };
}

const teamLineText = (l: TeamLine) => `${l.name}: ${countsLine(l.overdue, l.today)}`;

export function renderOwnerSummary(input: {
  name: string | null; today: string; tasksUrl: string; totals: DigestTotals; team: TeamLine[];
  overdue: DigestTask[]; dueToday: DigestTask[];
}): DigestMessage {
  const first = firstName(input.name);
  const counts = countsLine(input.totals.overdue, input.totals.today);
  const own = taskBlocks(input.today, input.overdue, input.dueToday);
  return {
    subject: `Team tasks for ${formatIstDate(input.today)}: ${counts}`,
    text: [
      first ? `Hi ${first},` : "Hi,",
      "",
      `Team tasks: ${counts}`,
      ...capped(input.team.map((l) => `- ${teamLineText(l)}`)),
      "",
      ...(own.length > 0 ? ["Your own tasks", "", ...own] : []),
      `Open tasks: ${input.tasksUrl}`,
    ].join("\n"),
  };
}

/** One line, no new lines / tabs / runs of spaces — Meta refuses those in a template value. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function joinCapped(items: string[]): string {
  const shown = items.slice(0, MAX_WA_NAMES).join("; ");
  const more = items.length - MAX_WA_NAMES;
  const line = more > 0 ? `${shown} (+${more} more)` : shown;
  return line.length > MAX_WA_VALUE ? `${line.slice(0, MAX_WA_VALUE - 1)}…` : line;
}

/**
 * The three body values of the `task_daily_digest` template. A personal digest lists task
 * names; an owner summary (pass `team` + `totals`) lists the team lines.
 */
export function digestWhatsAppValues(input: {
  name: string | null; overdue: DigestTask[]; dueToday: DigestTask[]; team?: TeamLine[]; totals?: DigestTotals;
}): string[] {
  const counts = input.totals
    ? countsLine(input.totals.overdue, input.totals.today)
    : countsLine(input.overdue.length, input.dueToday.length);
  const items = input.team && input.team.length > 0
    ? input.team.map((l) => oneLine(teamLineText(l)))
    : [...input.overdue, ...input.dueToday].map((t) => oneLine(t.title));
  return [firstName(input.name) ?? "there", counts, joinCapped(items)];
}
