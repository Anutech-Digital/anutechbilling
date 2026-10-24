/**
 * The folders a salesperson understands, over the states the system actually stores.
 *
 * ─── WHY THE OLD NAMES HAD TO GO ────────────────────────────────────────────
 * The page used to offer `untriaged`, `appended` and `skipped`. Those are the
 * webhook's words for what IT did — they describe the pipeline, not the rep's day.
 * "Appended" tells a salesperson nothing about whether they owe someone a reply.
 *
 * ─── TWO KINDS OF STATE, KEPT APART ─────────────────────────────────────────
 * `status` is what the SYSTEM did (received / lead_created / skipped_non_enquiry…).
 * `starred`, `read_at`, `snoozed_until`, `archived_at` are what a PERSON did. They
 * move independently — an email can be `lead_created` and still unread and starred —
 * so folders that mixed them would have to change a pipeline value to flag a mail,
 * and every report reading `status` would then be wrong.
 *
 * ─── SNOOZED IS NOT ARCHIVED ────────────────────────────────────────────────
 * A snoozed email leaves the Inbox and COMES BACK when its moment passes. That is
 * the entire promise of snoozing, and it is why `snoozed_until` is compared to now
 * on every read rather than being flipped by a job that might not run.
 */
import type { InboundEmailRow } from "@/lib/supabase/database.types";
import { isSentReply, SENT_REPLY_STATUS } from "./sent";
import { groupIntoThreads, type ThreadableEmail } from "./threads";

export type MailFolder =
  | "inbox" | "starred" | "snoozed" | "leads" | "sent" | "done" | "spam";

export interface FolderMeta {
  id:    MailFolder;
  label: string;
  icon:  string;
  /** One line of plain English, shown when the folder is empty. */
  hint:  string;
}

export const MAIL_FOLDERS: readonly FolderMeta[] = [
  { id: "inbox",   label: "Inbox",           icon: "📥", hint: "New enquiries waiting on you." },
  { id: "starred", label: "Starred",         icon: "⭐", hint: "Nothing flagged yet — star an enquiry to keep it here." },
  { id: "snoozed", label: "Snoozed",         icon: "⏰", hint: "Nothing put off. Snoozed mail comes back to the Inbox on its own." },
  { id: "leads",   label: "Converted Leads", icon: "🎯", hint: "Enquiries that became a lead will collect here." },
  { id: "sent",    label: "Sent",            icon: "📤", hint: "Replies you send from an enquiry are kept here, with what you wrote." },
  { id: "done",    label: "Done",            icon: "✅", hint: "Nothing archived yet. Finished enquiries land here — nothing is ever deleted." },
  { id: "spam",    label: "Spam / System",   icon: "🚫", hint: "Automated and non-sales mail is filed here, out of the Inbox." },
] as const;

/** The subset of a row the folder rules read. Structural so tests need no DB row. */
export type FoldersRow = Pick<
  InboundEmailRow, "status" | "lead_id"
> & {
  starred:       boolean | null;
  snoozed_until: string | null;
  archived_at:   string | null;
};

/**
 * What counting needs on top of what filing needs.
 *
 * `inFolder` only ever asks whether ONE row belongs somewhere, so `FoldersRow` is
 * deliberately small. Counting has to group rows into conversations first, and that
 * needs the fields `threadKey` reads. Kept as a separate type so the filing rules do not
 * quietly acquire a dependency they do not have.
 */
export type CountableRow = FoldersRow & ThreadableEmail;

/**
 * Statuses that mean "the system decided this is not a sales enquiry".
 *
 * `error` is deliberately NOT here. A mail the pipeline choked on is exactly the one
 * a human should see — hiding it in Spam is how a real enquiry disappears because a
 * parser threw.
 */
const SPAM_STATUS_LIST = ["skipped_non_enquiry", "duplicate"] as const;
const SPAM_STATUSES = new Set<string>(SPAM_STATUS_LIST);

/** Statuses that never reach the Inbox: system mail and our own sent replies. nav_badges()
 *  (R-1541) leaves out the same list when it counts the Inbox's unread conversations. */
export const INBOX_HIDDEN_STATUSES: readonly string[] = [...SPAM_STATUS_LIST, SENT_REPLY_STATUS];

export function isSpam(row: FoldersRow): boolean {
  return SPAM_STATUSES.has(row.status);
}

/** Is this email currently hidden by a snooze? */
export function isSnoozed(row: FoldersRow, nowISO: string): boolean {
  return row.snoozed_until != null && row.snoozed_until > nowISO;
}

/**
 * Does this email belong in that folder right now?
 *
 * Folders OVERLAP on purpose, the way Gmail's labels do: a starred enquiry that has
 * become a lead shows in Inbox, Starred and Converted Leads. Making them exclusive
 * would mean starring something removed it from the Inbox, which is the opposite of
 * what a flag is for.
 */
export function inFolder(row: FoldersRow, folder: MailFolder, nowISO: string): boolean {
  const archived = row.archived_at != null;

  /* A reply WE sent belongs in exactly one folder and no other. Without this it would
     land in the Inbox as work owed to somebody, which is the opposite of what it is —
     and every count on the rail would be inflated by our own outgoing mail. */
  if (isSentReply(row)) return folder === "sent";

  switch (folder) {
    case "inbox":
      /* Everything a rep still owes an answer on. Archived, snoozed and system mail
         are the three things that have already been dealt with or were never work. */
      return !archived && !isSnoozed(row, nowISO) && !isSpam(row);

    case "starred":
      /* Shows wherever the mail lives — including archived. A flag that vanished
         when you filed the mail would not be a flag. */
      return row.starred === true;

    case "snoozed":
      return isSnoozed(row, nowISO);

    case "leads":
      return row.lead_id != null;

    case "done":
      return archived;

    case "spam":
      return isSpam(row);

    case "sent":
      /* Reached only by rows that are NOT sent replies — the guard at the top already
         answered for those. An inbound enquiry is never in Sent. */
      return false;
  }
}

/**
 * How many CONVERSATIONS are in each folder — the numbers beside the folder names.
 *
 * ─── THIS USED TO COUNT MESSAGES, AND THE TWO NUMBERS SAT SIDE BY SIDE ──────
 * Measured on the live screen 30 Aug 2026: the rail said **Inbox 17** and the list
 * header two centimetres to its right said **INBOX (12)**, above twelve rows. Both were
 * correct — seventeen messages grouped into twelve conversations — and together they
 * read as a bug, because nothing on the screen said the two words meant different
 * things. On mobile it was worse: the folder picker said "Inbox (17)" and was the only
 * number visible, sitting directly above twelve rows.
 *
 * The rail's number answers one question: *how much will I see if I click here.* The
 * list shows conversations, so the answer is conversations. A number beside a folder
 * name that does not match the rows behind it is not a second useful statistic, it is
 * the same statistic said wrong.
 *
 * The grouping is `groupIntoThreads`, the same function the page uses to build the list
 * — not a second implementation of "what counts as one conversation". That is the whole
 * point: one of these numbers being computed a different way is how they disagreed.
 */
export function folderCounts(
  rows: readonly CountableRow[],
  nowISO: string,
): Record<MailFolder, number> {
  const counts = {
    inbox: 0, starred: 0, snoozed: 0, leads: 0, sent: 0, done: 0, spam: 0,
  } as Record<MailFolder, number>;
  for (const f of MAIL_FOLDERS) {
    counts[f.id] = groupIntoThreads(rows.filter((r) => inFolder(r, f.id, nowISO))).length;
  }
  return counts;
}

/**
 * When "snooze until tomorrow" actually means, in IST.
 *
 * ─── THE HOUR IS THE POINT ──────────────────────────────────────────────────
 * "Tomorrow" has to mean tomorrow MORNING, not 00:01. A mail that reappears at
 * midnight is back in the Inbox for a whole shift before anyone is at a desk, and
 * the rep who snoozed it sees it again having gained nothing.
 *
 * India is UTC+5:30 with no daylight saving, so the offset is a constant — no
 * timezone database, and the arithmetic is honest for the only market this serves.
 */
const IST_OFFSET_MIN = 5 * 60 + 30;
/** 09:00 IST — the start of a working day. */
const SNOOZE_HOUR_IST = 9;

export interface SnoozePreset {
  label: string;
  /** ISO instant to hide it until. */
  untilISO: string;
}

/** Next occurrence of 09:00 IST, `daysAhead` days from now. */
function istMorning(now: Date, daysAhead: number): string {
  const ist = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  ist.setUTCDate(ist.getUTCDate() + daysAhead);
  ist.setUTCHours(SNOOZE_HOUR_IST, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MIN * 60_000).toISOString();
}

export function snoozePresets(now: Date): SnoozePreset[] {
  return [
    { label: "Tomorrow morning",   untilISO: istMorning(now, 1) },
    { label: "In 3 days",          untilISO: istMorning(now, 3) },
    { label: "Next week",          untilISO: istMorning(now, 7) },
  ];
}

/**
 * Unread count for the Inbox badge.
 *
 * Only the Inbox gets one. Gmail shows unread counts per folder, but a rep acting on
 * "12 unread" needs that to mean twelve things to do — counting unread mail that is
 * archived or snoozed inflates it with work already handled.
 */
export function inboxUnread(
  rows: readonly (CountableRow & { read_at: string | null })[],
  nowISO: string,
): number {
  /* Conversations, not messages — and the docstring above is why. "Twelve things to do"
     has to survive a customer sending three mails in a row, which is one thing to read
     and one thing to answer. Counting messages turned that into three.

     A conversation counts once if ANY message in it is unread: opening the thread shows
     the whole thing, so one visit clears it however many messages it holds. */
  const inbox = rows.filter((r) => inFolder(r, "inbox", nowISO));
  return groupIntoThreads(inbox).filter(
    (t) => t.messages.some((m) => m.read_at == null),
  ).length;
}
