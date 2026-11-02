/**
 * R-2230 (Zoho Billing audit A6) — what open part payment requests still owe, and when.
 *
 * A subscription billed in parts gets a PAYMENT REQUEST (a quote, R-2044) for each part; its tax
 * invoice is raised only when it is paid. So an unpaid part is not an unpaid invoice — and the
 * screens that only read invoices said "No payment due date" next to "₹1,632 due", and "Unpaid
 * invoices now ₹0" next to Outstanding ₹1,632.
 *
 * The rows come from ONE database read, public.open_part_requests (migration
 * 20261101184900_r2230_part_due_dates): one row per part a request covers, each with the request's
 * due date (subscription_billings.due_on = part start + payment terms) and what the REQUEST still
 * owes. A request for a quote's period can cover several subscriptions (R-2092), so a total sums
 * the `is_lead` rows only — one per request. The credit-limit check in activate_quote_on_credit
 * sums the same rows, so the customer page and the database never disagree.
 */

import { rupee, formatDate } from "@/lib/utils";
import { paymentDueState } from "@/lib/subscriptions/payment-due";

export interface OpenPartRequest {
  quote_id: string;
  customer_id: string | null;
  subscription_id: string;
  billing_id: string;
  term_start: string;
  period_index: number;
  /** YYYY-MM-DD — when the request is due. */
  due_on: string | null;
  /** ₹ the REQUEST still owes (the same on every row of one request). */
  still_due: number;
  /** One row per request is the lead — sum these for a total. */
  is_lead: boolean;
}

const ymd = (d: string | null | undefined) => (d ? d.slice(0, 10) : null);

/** ₹ still owed on open part requests — each request counted once. */
export function partRequestsOwed(rows: readonly OpenPartRequest[]): number {
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (!seen.has(r.quote_id) || r.is_lead) seen.set(r.quote_id, Math.max(0, Math.round(r.still_due ?? 0)));
  }
  let sum = 0;
  for (const v of seen.values()) sum += v;
  return sum;
}

/** The oldest due date among the rows (YYYY-MM-DD), or null. */
export function oldestPartDue(rows: readonly OpenPartRequest[]): string | null {
  const dates = rows.map((r) => ymd(r.due_on)).filter((d): d is string => !!d).sort();
  return dates[0] ?? null;
}

/** subscription id → the oldest due date of its open part requests. */
export function oldestPartDueBySubscription(rows: readonly OpenPartRequest[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    const d = ymd(r.due_on);
    if (!d) continue;
    const cur = out.get(r.subscription_id);
    if (!cur || d < cur) out.set(r.subscription_id, d);
  }
  return out;
}

/** The open request for one part of a subscription (billing schedule row), if any. */
export function partRequestFor(
  rows: readonly OpenPartRequest[],
  part: { subscriptionId: string; termStart: string | null | undefined; periodIndex: number },
): OpenPartRequest | undefined {
  const term = ymd(part.termStart);
  return rows.find((r) => r.subscription_id === part.subscriptionId
    && r.period_index === part.periodIndex
    && (!term || ymd(r.term_start) === term));
}

/** The customer page's "Unpaid now": unpaid invoices + open part requests. */
export interface UnpaidNow {
  invoices: number;
  requests: number;
  total: number;
  /** Oldest due date of the open requests (YYYY-MM-DD), null when none. */
  requestsDueFrom: string | null;
}

export function unpaidNow(invoicesOwed: number, requests: readonly OpenPartRequest[]): UnpaidNow {
  const req = partRequestsOwed(requests);
  const inv = Math.max(0, Math.round(invoicesOwed));
  return { invoices: inv, requests: req, total: inv + req, requestsDueFrom: req > 0 ? oldestPartDue(requests) : null };
}

/**
 * The billing schedule's line for a part with an open request (subscription drawer):
 * "Payment request Q-… · ₹1,632 due 16 Nov 2026", or "· 5 days overdue (due 28 Oct 2026)".
 */
export function partRequestChipText(r: OpenPartRequest, todayISO: string): string {
  const head = `Payment request ${r.quote_id} · ${rupee(r.still_due)}`;
  const due = ymd(r.due_on);
  if (!due) return `${head} due`;
  const state = paymentDueState(due, todayISO, r.still_due);
  if (state.kind === "overdue") return `${head} · ${state.label} (due ${formatDate(due)})`;
  if (state.kind === "due_today") return `${head} due today`;
  return `${head} due ${formatDate(due)}`;
}
