/**
 * R-2404 — who is working each renewal, when they follow up next, where the customer's decision
 * stands and whether a promise to pay was broken (Pardeep, 3 Nov 2026: "renewal page ke liye deep
 * audit and analysis karke ise aur improve karo take user ko aur team ko kaam karne me aasani ho").
 * Audit: renewals had no owner, no next date and no last contact; Payment Follow-up already had
 * them (R-1515/1516/1517).
 *
 * ONE model, no second copy: a renewal's follow-ups are payment_followups rows whose
 * subscription_id is the renewal's subscription (the column exists since R-1515). So:
 *   • owner        = defaultAssignee (followup-rules.ts): the newest of THIS renewal's follow-ups'
 *                    assigned_to, else the customer's owner (customers.account_manager_id).
 *   • next date    = the newest follow-up's next_follow_up_on; due = today or earlier (the same
 *                    rule as Payment Follow-up's followUpDue).
 *   • promise      = the newest follow-up that carries a promised_on; its status is promiseStatus
 *                    (THE one rule, R-1540). "Still owes" = the renewal is not paid; the renewal's
 *                    own payment is what keeps it (a paid renewal → kept).
 *   • Confirmed    = a follow-up whose outcome is "renewal_confirmed" (the Follow-up dialog's
 *                    "Customer confirmed the renewal" tick) — the only decision step a person sets
 *                    here. "Won't renew" stays the existing Won't renew action (auto_renew = false,
 *                    R-2225): one way per task.
 * Decision status (renewalDecision): Not contacted → Contacted → Quote sent → Confirmed →
 * Invoiced → Paid / Won't renew. Quote sent / Confirmed (accepted) / Invoiced / Paid come from the
 * app itself (the linked renewal quote and the row status), so nobody has to keep them in step.
 * Pure — tested in followup-r2404.test.ts.
 */
import {
  compareFollowupsNewestFirst, defaultAssignee, defaultNextFollowUp, promiseLoggedOn, promiseStatus,
  RENEWAL_CONFIRMED, type FollowupRequest, type PromiseStatus,
} from "@/lib/collections/followup-rules";
import { toIstDate } from "@/lib/dates/ist";
import type { RowStatusKey } from "./queue";

/** A payment_followups row as the Renewals page reads it. */
export interface RenewalFollowupRow {
  id: string;
  customer_id: string;
  subscription_id: string | null;
  kind: string;
  note: string | null;
  outcome: string | null;
  promised_amount: number | null;
  promised_on: string | null;
  next_follow_up_on: string | null;
  assigned_to: string | null;
  created_at: string;
}

export interface RenewalFollowup {
  /** Who works this renewal (null = nobody yet). */
  ownerId: string | null;
  nextFollowUpOn: string | null;
  /** Next follow-up is today or already past. */
  followUpDue: boolean;
  promisedOn: string | null;
  promisedAmount: number | null;
  promiseStatus: PromiseStatus | null;
  promiseBroken: boolean;
  /** When the newest follow-up was logged (the last contact). */
  lastContactAt: string | null;
  /** A person ticked "Customer confirmed the renewal" on a follow-up. */
  confirmed: boolean;
  /** Number of follow-ups logged on this renewal. */
  count: number;
}

/** This subscription's follow-ups, newest first. */
export function followupsOfRenewal(subscriptionId: string, rows: readonly RenewalFollowupRow[]): RenewalFollowupRow[] {
  return rows.filter((r) => r.subscription_id === subscriptionId).sort(compareFollowupsNewestFirst);
}

/**
 * The renewal's follow-up state.
 * @param customerOwnerId customers.account_manager_id
 * @param paid the renewal is paid (row status Renewed) — keeps a promise, never "broken".
 */
export function renewalFollowup(
  subscriptionId: string,
  rows: readonly RenewalFollowupRow[],
  opts: { customerOwnerId: string | null | undefined; today: string; paid: boolean },
): RenewalFollowup {
  const fus = followupsOfRenewal(subscriptionId, rows);
  const latest = fus[0];
  const next = latest?.next_follow_up_on?.slice(0, 10) ?? null;
  const promise = fus.find((f) => !!f.promised_on);
  let status: PromiseStatus | null = null;
  let on: string | null = null;
  if (promise?.promised_on) {
    on = promise.promised_on.slice(0, 10);
    status = promiseStatus({
      promisedOn: on,
      promisedAmount: promise.promised_amount,
      loggedOn: promiseLoggedOn(fus, on) ?? toIstDate(promise.created_at),
      today: opts.today,
      receipts: [],
      stillOwes: !opts.paid,
    }).status;
  }
  return {
    ownerId: defaultAssignee({ latestAssignedTo: latest?.assigned_to, ownerId: opts.customerOwnerId, meId: null }),
    nextFollowUpOn: next,
    followUpDue: !!next && next <= opts.today,
    promisedOn: on,
    promisedAmount: promise?.promised_amount ?? null,
    promiseStatus: status,
    promiseBroken: status === "broken",
    lastContactAt: latest?.created_at ?? null,
    confirmed: fus.some((f) => f.outcome === RENEWAL_CONFIRMED),
    count: fus.length,
  };
}

// ─── Decision status ────────────────────────────────────────────────────────

export type RenewalDecision = "not-contacted" | "contacted" | "quote-sent" | "confirmed" | "invoiced" | "paid" | "wont-renew";

export const DECISION_LABEL: Record<RenewalDecision, string> = {
  "not-contacted": "Not contacted",
  contacted: "Contacted",
  "quote-sent": "Quote sent",
  confirmed: "Confirmed",
  invoiced: "Invoiced",
  paid: "Paid",
  "wont-renew": "Won't renew",
};

export const DECISION_TONE: Record<RenewalDecision, "danger" | "warning" | "info" | "success" | "muted"> = {
  "not-contacted": "warning",
  contacted: "muted",
  "quote-sent": "info",
  confirmed: "success",
  invoiced: "info",
  paid: "success",
  "wont-renew": "muted",
};

/**
 * Where the customer's decision stands. First match wins:
 *   Won't renew (auto_renew false) → Paid (the row is Renewed) → Invoiced (the renewal quote is
 *   invoiced) → Confirmed (quote accepted, or a person ticked it) → Quote sent (the renewal quote
 *   went out: sent / viewed) → Contacted (a follow-up was logged) → Not contacted.
 * A draft renewal quote is not "sent". A linked quote whose status is not loaded counts as sent —
 * the same assumption as renewalRowAction (R-2232).
 */
export function renewalDecision(
  sub: { auto_renew?: boolean | null; renewal_quote_id?: string | null },
  ctx: {
    statusKey: RowStatusKey;
    quote: { id: string; status: string | null; payment_status?: string | null } | null | undefined;
    followup: Pick<RenewalFollowup, "confirmed" | "count">;
  },
): RenewalDecision {
  if (sub.auto_renew === false) return "wont-renew";
  if (ctx.statusKey === "renewed") return "paid";
  const q = sub.renewal_quote_id && ctx.quote && ctx.quote.id === sub.renewal_quote_id ? ctx.quote : null;
  if (q?.payment_status === "invoiced") return "invoiced";
  if (q?.status === "accepted" || ctx.followup.confirmed) return "confirmed";
  const sent = sub.renewal_quote_id && (!q || (q.status !== "draft" && q.status !== "rejected" && q.status !== "expired"));
  if (sent) return "quote-sent";
  return ctx.followup.count > 0 ? "contacted" : "not-contacted";
}

/** The row's status chip already says Renewed / Non-renewing — the decision is not repeated then. */
export function showDecision(d: RenewalDecision): boolean {
  return d !== "paid" && d !== "wont-renew";
}

// ─── Filters: Mine · Follow-up due · Promise broken ─────────────────────────

export interface FollowupFilters {
  mine: boolean;
  followUpDue: boolean;
  promiseBroken: boolean;
}

export const NO_FOLLOWUP_FILTERS: FollowupFilters = { mine: false, followUpDue: false, promiseBroken: false };

export function filterByFollowup<T extends { followup: Pick<RenewalFollowup, "ownerId" | "followUpDue" | "promiseBroken"> }>(
  rows: readonly T[],
  f: FollowupFilters,
  meId: string | null | undefined,
): T[] {
  return rows.filter((r) =>
    (!f.mine || (!!meId && r.followup.ownerId === meId))
    && (!f.followUpDue || r.followup.followUpDue)
    && (!f.promiseBroken || r.followup.promiseBroken));
}

// ─── Bulk: Assign owner ─────────────────────────────────────────────────────

export const ASSIGN_NEEDS_ROLE =
  "Only an owner, manager or accountant can give renewals to someone. Ask your manager to assign them, or log a follow-up on the row yourself.";

/**
 * One follow-up per ticked renewal, through the same POST /api/collections/followups as the
 * Follow-up dialog (the server re-checks who may reassign; the DB trigger too). The note says who
 * it went to; the next follow-up date is kept when it is today or later, else today + 3 days.
 * Rows without a customer cannot carry a follow-up and are skipped (named in the result).
 */
export function bulkAssignRequests<T extends { sub: { id: string; customer_id: string | null; customer_name: string }; followup: Pick<RenewalFollowup, "nextFollowUpOn"> }>(
  rows: readonly T[],
  assignee: { id: string; name: string },
  today: string,
): { requests: { row: T; body: FollowupRequest }[]; skipped: { row: T; reason: string }[] } {
  const requests: { row: T; body: FollowupRequest }[] = [];
  const skipped: { row: T; reason: string }[] = [];
  for (const r of rows) {
    if (!r.sub.customer_id) { skipped.push({ row: r, reason: "no customer on this subscription" }); continue; }
    const next = r.followup.nextFollowUpOn && r.followup.nextFollowUpOn >= today ? r.followup.nextFollowUpOn : defaultNextFollowUp(today);
    requests.push({
      row: r,
      body: {
        customerId: r.sub.customer_id,
        kind: "note",
        note: `Renewal owner: ${assignee.name}`,
        nextFollowUpOn: next,
        assignedTo: assignee.id,
        subscriptionId: r.sub.id,
      },
    });
  }
  return { requests, skipped };
}

/** The one-line report after a bulk assign (§24: who failed and what to do). */
export function bulkAssignReport(
  done: number,
  failed: readonly { name: string; error: string }[],
  assigneeName: string,
): { tone: "success" | "warning" | "error"; title: string; description?: string } {
  if (failed.length === 0) return { tone: "success", title: `${done} renewal${done === 1 ? "" : "s"} given to ${assigneeName}` };
  const list = failed.slice(0, 3).map((f) => `${f.name} — ${f.error}`).join("; ") + (failed.length > 3 ? `; and ${failed.length - 3} more` : "");
  return {
    tone: done > 0 ? "warning" : "error",
    title: done > 0 ? `${done} given to ${assigneeName}, ${failed.length} not saved` : `None given to ${assigneeName}`,
    description: `${list}. Press Retry failed, or open the row's Follow-up.`,
  };
}
