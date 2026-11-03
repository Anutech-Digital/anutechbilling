/**
 * R-2409 — Payment Follow-up: "Today" work, the priority order and ONE stage per row. Pure —
 * tested in priority.test.ts; lib/queries/collections.ts fills the row fields from it and
 * app/(app)/collections uses it for the Today view, the "Today's work first" sort and the chip.
 *
 * TODAY = what a person must do today:
 *   • a follow-up whose date is today or already past (a missed one is still today's work);
 *   • a promise-to-pay that falls today (promiseStatus "due" — the money should come in today);
 *   • a broken promise (the date passed, the promised cash did not come — R-1540).
 *
 * PRIORITY ("Today's work first"): broken promises first, then the rest of today's work, then
 * everyone else. Inside each group the biggest score first: score = Σ over the row's LATE owed
 * lines of (₹ due × days late) — ₹1,00,000 late 10 days (10,00,000) comes before ₹20,000 late
 * 30 days (6,00,000). A renewal already past its date adds its renewal amount × days past, as
 * R-2401 ranks it like an overdue invoice of the same age (it is still never counted as owed).
 * Ties: most days late, biggest amount, then name.
 *
 * STAGE — one chip per row, the first that holds:
 *   Disputed      an open dispute (R-2411 openDispute — reminders are paused)
 *   Broken        the newest promise's date passed unpaid (R-1540 promiseStatus "broken")
 *   Promised      the newest promise's date is today or ahead (R-2411 promise hold)
 *   Part-paid     some money already came in on an open invoice (paid_amount > 0)
 *   Reminded      a reminder or contact is on record for these dues (a call / WhatsApp / email /
 *                 meeting / promise entry since a week before the oldest open line fell due, or
 *                 an automatic reminder email the dunning cron delivered for an open invoice)
 *   Not contacted none of the above
 */
import { addDaysISO, toIstDate } from "@/lib/dates/ist";
import { stageFor, type CollectionHold } from "./followup-rules";

export const STAGES = ["notContacted", "reminded", "promised", "broken", "disputed", "partPaid"] as const;
export type CollectionStage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<CollectionStage, string> = {
  notContacted: "Not contacted",
  reminded: "Reminded",
  promised: "Promised",
  broken: "Broken",
  disputed: "Disputed",
  partPaid: "Part-paid",
};

/** Badge kind per stage (components/ui/badge). */
export const STAGE_TONE: Record<CollectionStage, "muted" | "info" | "success" | "danger" | "warning"> = {
  notContacted: "muted",
  reminded: "info",
  promised: "success",
  broken: "danger",
  disputed: "warning",
  partPaid: "info",
};

export const STAGE_HINT: Record<CollectionStage, string> = {
  notContacted: "No reminder, call or promise on record for these dues yet",
  reminded: "A reminder or call is on record — no promise yet",
  promised: "Customer promised to pay — reminders paused until that date",
  broken: "The promise date passed and the promised money did not come in",
  disputed: "Customer disputes the bill — reminders paused until it is resolved",
  partPaid: "Some money already came in on an open bill",
};

/** Follow-up kinds that mean the customer was contacted (a "note" is internal, not contact). */
export const CONTACT_KINDS: ReadonlySet<string> = new Set(["call", "whatsapp", "email", "meeting", "promise"]);

/** Contact this many days before the oldest line fell due still counts (a pre-due reminder). */
export const CONTACT_WINDOW_DAYS = 7;

/**
 * The first IST day from which a contact counts for this row's dues: a week before its oldest
 * open line fell due (daysOverdue of the oldest line; negative = not due yet).
 */
export function contactSince(today: string, daysOverdue: number): string {
  return addDaysISO(today, -Math.max(daysOverdue, -CONTACT_WINDOW_DAYS) - CONTACT_WINDOW_DAYS);
}

/** Was the customer contacted / reminded about the dues they have now? */
export function wasReminded(opts: {
  today: string;
  daysOverdue: number;
  followups: readonly { kind: string; created_at: string }[];
  /** Delivered automatic reminders (invoice_dunning_log status "sent") for this row's open invoices. */
  autoReminders: number;
}): boolean {
  if (opts.autoReminders > 0) return true;
  const since = contactSince(opts.today, opts.daysOverdue);
  return opts.followups.some((f) => CONTACT_KINDS.has(f.kind) && toIstDate(f.created_at) >= since);
}

export function rowStage(r: { hold: CollectionHold | null; promiseBroken: boolean; partPaid: boolean; reminded: boolean }): CollectionStage {
  const hold = stageFor(r);
  if (hold) return hold;
  if (r.partPaid) return "partPaid";
  return r.reminded ? "reminded" : "notContacted";
}

/** Σ ₹ due × days late over the LATE owed lines, whole rupees. */
export function priorityScore(items: readonly { amountDue: number; daysOverdue: number }[]): number {
  return items.reduce((s, i) => s + (i.daysOverdue > 0 && i.amountDue > 0 ? Math.round(i.amountDue) * i.daysOverdue : 0), 0);
}

export interface PriorityRow {
  customerName: string;
  amountDue: number;
  daysOverdue: number;
  followUpDue: boolean;
  promiseStatus: string | null;
  promiseBroken: boolean;
  priorityScore: number;
}

/** A promise that falls today — the money should come in today. */
export function promiseDueToday(r: Pick<PriorityRow, "promiseStatus">): boolean {
  return r.promiseStatus === "due";
}

/** Today's work: follow-up due (or missed), promise due today, or a broken promise. */
export function isTodayWork(r: Pick<PriorityRow, "followUpDue" | "promiseStatus" | "promiseBroken">): boolean {
  return r.followUpDue || r.promiseBroken || promiseDueToday(r);
}

/** 0 = broken promise, 1 = other work for today, 2 = the rest. */
export function priorityTier(r: Pick<PriorityRow, "followUpDue" | "promiseStatus" | "promiseBroken">): 0 | 1 | 2 {
  if (r.promiseBroken) return 0;
  return isTodayWork(r) ? 1 : 2;
}

/** "Today's work first": tier, then score, days late, amount, name. */
export function comparePriority(a: PriorityRow, b: PriorityRow): number {
  return priorityTier(a) - priorityTier(b)
    || b.priorityScore - a.priorityScore
    || b.daysOverdue - a.daysOverdue
    || b.amountDue - a.amountDue
    || a.customerName.localeCompare(b.customerName);
}

/** What the Today view counts, for the button and the summary line. */
export function todayCounts(rows: readonly Pick<PriorityRow, "followUpDue" | "promiseStatus" | "promiseBroken">[]): {
  total: number; followUps: number; promisesToday: number; broken: number;
} {
  let total = 0, followUps = 0, promisesToday = 0, broken = 0;
  for (const r of rows) {
    if (!isTodayWork(r)) continue;
    total += 1;
    if (r.followUpDue) followUps += 1;
    if (promiseDueToday(r)) promisesToday += 1;
    if (r.promiseBroken) broken += 1;
  }
  return { total, followUps, promisesToday, broken };
}
