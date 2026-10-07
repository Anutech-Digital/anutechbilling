/**
 * R-116 — pause a subscription when its invoice stays unpaid (per company, default OFF).
 *
 * EXTENDS the invoice dunning cron, it does not replace it. That cron already chases every
 * unpaid invoice (pre-due → day 14) and already read `tenants.auto_suspend_on_overdue`, but
 * its pause fired on a fixed Day 14 with no warning that a pause was coming. This module is
 * the pure half of the new rule; `overdue-suspension.server.ts` reads and writes the rows.
 *
 * THE RULE, per subscription, for a company that switched it on:
 *   1. Find the OLDEST unpaid invoice that bills this subscription. "Unpaid" is the same
 *      balance every other screen uses — `invoiceAmountDue`: net_payable (after credit notes
 *      and advances) minus receipts. A part payment keeps it unpaid; a credit note that brings
 *      it to zero settles it.
 *   2. Days overdue are counted in IST calendar days (Cloud Run runs in UTC — before 05:30
 *      IST a UTC date is yesterday's, AGENTS.md §6).
 *   3. A final NOTICE goes to the customer NOTICE_GRACE_DAYS before the pause, once.
 *   4. The pause happens on `pauseOn` = the later of (due + N + 1) and (notice + grace) — so
 *      it is never earlier than "more than N days overdue", and never with less than the
 *      promised notice, even when the cron missed days.
 *   5. Settling the invoice turns the service back on (database trigger
 *      trg_invoices_overdue_resume — immediate, not next morning).
 *
 * Nothing here calls Google or Microsoft. The status is the app's own; provisioning is a
 * separate card.
 */
import { invoiceAmountDue } from "@/lib/payments/amount-due";
import { addDaysISO, daysBetweenISO } from "@/lib/dates/ist";

/** Pause after this many days overdue when the company has not chosen a number. */
export const DEFAULT_SUSPEND_DAYS = 15;
/** The customer is told this many days before the pause. */
export const NOTICE_GRACE_DAYS = 3;
/** An invoice this many days overdue is offered for write-off (draft only). */
export const WRITE_OFF_AFTER_DAYS = 180;
/** The dunning-log step name for the pause notice. Unknown to the dunning ladder on purpose (ranks 0). */
export const SUSPEND_NOTICE_STEP = "suspend_notice";

export interface OverdueInvoice {
  id: string;
  status: string;
  amount?: number | null;
  net_payable?: number | null;
  paid_amount?: number | null;
  due_date: string | null;
}

export interface OldestOverdue {
  invoiceId: string;
  dueDate: string;
  amountDue: number;
  daysOverdue: number;
}

/** A company's threshold, or the default when it is missing or out of range (1..365). */
export function suspendThreshold(days: number | null | undefined): number {
  return typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= 365
    ? days
    : DEFAULT_SUSPEND_DAYS;
}

/** IST calendar days from the due date to `today` (both YYYY-MM-DD). Positive = late. */
export function overdueDays(dueDate: string, today: string): number {
  return daysBetweenISO(dueDate.slice(0, 10), today);
}

/**
 * The oldest invoice that is still owed AND past its due date. Paid, void, draft, no due
 * date, nothing left to pay, or not yet due → not a candidate. Ties go to the lower id so
 * the answer does not depend on read order.
 */
export function oldestOverdueInvoice(invoices: readonly OverdueInvoice[], today: string): OldestOverdue | null {
  let best: OldestOverdue | null = null;
  for (const inv of invoices) {
    if (inv.status !== "pending" && inv.status !== "overdue") continue;
    if (!inv.due_date) continue;
    const amountDue = invoiceAmountDue(inv);
    if (amountDue <= 0) continue;
    const days = overdueDays(inv.due_date, today);
    if (days <= 0) continue;
    const cand: OldestOverdue = { invoiceId: inv.id, dueDate: inv.due_date.slice(0, 10), amountDue, daysOverdue: days };
    if (!best || cand.dueDate < best.dueDate || (cand.dueDate === best.dueDate && cand.invoiceId < best.invoiceId)) {
      best = cand;
    }
  }
  return best;
}

/** The first overdue day on which the notice may go out. */
export function noticeFromDay(thresholdDays: number): number {
  return Math.max(1, suspendThreshold(thresholdDays) + 1 - NOTICE_GRACE_DAYS);
}

/** The IST date the service is paused on, given when the notice went (or goes) out. */
export function pauseOnDate(dueDate: string, thresholdDays: number, noticeOn: string): string {
  const byThreshold = addDaysISO(dueDate, suspendThreshold(thresholdDays) + 1);
  const byNotice = addDaysISO(noticeOn, NOTICE_GRACE_DAYS);
  return byThreshold > byNotice ? byThreshold : byNotice;
}

export type SuspensionAction = "none" | "notice" | "suspend";

export interface SuspensionInput {
  /** tenants.auto_suspend_on_overdue */
  enabled: boolean;
  /** tenants.overdue_suspend_days */
  thresholdDays: number | null | undefined;
  /** The subscription's current status. Only 'active' is ever paused. */
  subscriptionStatus: string;
  oldest: OldestOverdue | null;
  /** IST date the pause notice for `oldest` went out, or null when it has not. */
  noticeSentOn: string | null;
}

export interface SuspensionDecision {
  action: SuspensionAction;
  daysOverdue: number;
  /** When the pause happens (or would). Null when nothing is pending. */
  pauseOn: string | null;
  reason: string;
}

export function decideOverdueSuspension(input: SuspensionInput, today: string): SuspensionDecision {
  const none = (reason: string, daysOverdue = 0, pauseOn: string | null = null): SuspensionDecision =>
    ({ action: "none", daysOverdue, pauseOn, reason });

  if (!input.enabled) return none("Automatic pause is off for this company.");
  if (input.subscriptionStatus !== "active") return none(`Subscription is ${input.subscriptionStatus}.`);
  const o = input.oldest;
  if (!o) return none("No overdue invoice for this subscription.");

  const n = suspendThreshold(input.thresholdDays);
  const d = o.daysOverdue;
  if (d < noticeFromDay(n)) return none(`${d} days overdue — pause rule starts at ${n} days.`, d);

  if (!input.noticeSentOn) {
    const pauseOn = pauseOnDate(o.dueDate, n, today);
    return {
      action: "notice", daysOverdue: d, pauseOn,
      reason: `Invoice ${o.invoiceId} is ${d} days overdue. Final notice sent; service will be paused on ${pauseOn} if still unpaid.`,
    };
  }

  const pauseOn = pauseOnDate(o.dueDate, n, input.noticeSentOn);
  if (today < pauseOn) return none(`Notice sent on ${input.noticeSentOn}; pause due on ${pauseOn}.`, d, pauseOn);
  return {
    action: "suspend", daysOverdue: d, pauseOn,
    reason: `Invoice ${o.invoiceId} is ${d} days overdue (limit ${n} days). Final notice was sent on ${input.noticeSentOn}.`,
  };
}

export interface WriteOffCandidate {
  invoiceId: string;
  amountDue: number;
  daysOverdue: number;
}

/** Invoices more than WRITE_OFF_AFTER_DAYS overdue with money still owed, oldest first. */
export function writeOffCandidates(invoices: readonly OverdueInvoice[], today: string): WriteOffCandidate[] {
  const out: WriteOffCandidate[] = [];
  for (const inv of invoices) {
    if (inv.status !== "pending" && inv.status !== "overdue") continue;
    if (!inv.due_date) continue;
    const amountDue = invoiceAmountDue(inv);
    if (amountDue <= 0) continue;
    const days = overdueDays(inv.due_date, today);
    if (days > WRITE_OFF_AFTER_DAYS) out.push({ invoiceId: inv.id, amountDue, daysOverdue: days });
  }
  return out.sort((a, b) => b.daysOverdue - a.daysOverdue || a.invoiceId.localeCompare(b.invoiceId));
}

/** The customer's final notice. Plain English, states the date and how to stop it. */
export function suspensionNoticeMessage(args: {
  customerName: string;
  invoiceId: string;
  amountDue: string;
  dueDate: string;
  pauseOn: string;
  service: string;
  sellerName: string;
  /** From payInstruction(): "" or a sentence with the link. */
  payInstruction: string;
}): { subject: string; text: string } {
  const first = args.customerName.split(" ")[0] || "there";
  return {
    subject: `Invoice ${args.invoiceId} — service will be paused on ${args.pauseOn}`,
    text: `Hi ${first},\n\nInvoice ${args.invoiceId} for ${args.amountDue} was due on ${args.dueDate} and is still unpaid.\n\nIf it stays unpaid, ${args.service} will be paused on ${args.pauseOn}. Paying the invoice turns it back on straight away.${args.payInstruction}\n\nIf you have already paid, or something is holding the payment up, reply to this email and we will sort it out.\n\n— ${args.sellerName}`,
  };
}
