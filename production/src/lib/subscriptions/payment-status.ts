/**
 * R-2382 (Pardeep, 2 Nov 2026: "subscription ka payment status bhi dikhana chahiye") —
 * the Payment column of the Subscriptions list: is THIS subscription's current period
 * paid, and if not, how much is owed since when.
 *
 * ─── NO NEW RULES ────────────────────────────────────────────────────────────
 * Every number here comes from a truth the app already has:
 *  - what is owed  = `subscriptions.outstanding_amount` (the dues total — Payments,
 *    the customer page and the Status chips all read it);
 *  - since when    = the dues row of /payments (`fetchOutstandingReceivables`): the
 *    oldest unpaid invoice / open part request's due date (`pay_by`), else the day the
 *    age counts from (`age_from`); "overdue" is `paymentDueState`, the same countdown
 *    the row highlight and the Status chip use;
 *  - part-paid     = that dues row's `paid_amount` (money received on its own quote);
 *  - request sent  = an open renewal quote (sent / viewed / accepted, not superseded,
 *    not yet received) while nothing is owed yet;
 *  - paid till     = the current split-billing period's end when the subscription is
 *    billed in parts (subscription_billings), else its renewal date.
 *
 * Pure — the page batches the reads (one dues read, one quotes read, one current-period
 * read for every row), so a long list makes no per-row query.
 */
import { formatDate, rupee } from "@/lib/utils";
import { paymentDueState } from "./payment-due";

export type PaymentStatusKind =
  | "paid"
  | "due"
  | "overdue"
  | "part_paid"
  | "request_sent"
  | "no_bill"
  /** Ended, written off or billed elsewhere — no payment clock here. */
  | "none";

export type PaymentTone = "success" | "danger" | "warning" | "muted";

export interface PaymentStatus {
  kind: PaymentStatusKind;
  tone: PaymentTone;
  /** First line, e.g. "Paid till 12 Dec 2026" / "Due ₹14,406". */
  label: string;
  /** Small second line, e.g. "since 15 Sep 2026 · 48 days"; null when there is none. */
  detail: string | null;
  /** ₹ still owed (0 when nothing is). */
  owed: number;
  /** Owed and past its due date — the "Overdue" filter. */
  overdue: boolean;
}

export interface PaymentStatusSub {
  id: string;
  status: string | null;
  outstanding_amount: number | null;
  renewal_date: string | null;
  start_date: string | null;
  payment_due_date?: string | null;
  quote_id: string | null;
  renewal_quote_id: string | null;
  written_off_at?: string | null;
  billed_externally_until?: string | null;
}

/** The fields of the /payments dues row this needs (OutstandingRow). */
export interface PaymentStatusDue {
  paid_amount: number;
  pay_by?: string | null;
  age_from: string;
}

export interface PaymentStatusQuote {
  id: string;
  status: string | null;
  payment_status: string | null;
  superseded_by?: string | null;
  amount: number | null;
  created_date?: string | null;
  created_at?: string | null;
}

/** The subscription_billings row whose period contains today. */
export interface CurrentBillingPeriod {
  subscription_id: string;
  period_start: string;
  period_end: string;
  bill_on: string;
  invoice_id: string | null;
}

const ymd = (d: string | null | undefined) => (d ? d.slice(0, 10) : null);
const dayWord = (n: number) => (n === 1 ? "day" : "days");

/** An open renewal quote — asked for, not yet paid, not replaced. */
function openRequest(q: PaymentStatusQuote | undefined): PaymentStatusQuote | undefined {
  if (!q) return undefined;
  if (q.superseded_by) return undefined;
  if (q.payment_status === "received") return undefined;
  return q.status === "sent" || q.status === "viewed" || q.status === "accepted" ? q : undefined;
}

export function subscriptionPaymentStatus(input: {
  sub: PaymentStatusSub;
  /** Its /payments dues row, when it owes money. */
  due?: PaymentStatusDue | null;
  /** Its renewal quote (sub.renewal_quote_id), when readable. */
  renewalQuote?: PaymentStatusQuote | null;
  /** Its current split-billing period, when billed in parts. */
  period?: CurrentBillingPeriod | null;
  /** YYYY-MM-DD in IST. */
  today: string;
}): PaymentStatus {
  const { sub, due, renewalQuote, period, today } = input;
  const owed = Math.max(0, Math.round(sub.outstanding_amount ?? 0));
  const quiet = (label: string, detail: string | null = null): PaymentStatus =>
    ({ kind: "none", tone: "muted", label, detail, owed, overdue: false });

  if (sub.written_off_at) return quiet("Written off");

  if (owed > 0) {
    const dueDate = ymd(due?.pay_by) ?? ymd(due?.age_from) ?? ymd(sub.payment_due_date) ?? ymd(sub.start_date);
    const clock = paymentDueState(dueDate, today, owed);
    const overdue = clock.kind === "overdue";
    const late = overdue || clock.kind === "due_today";
    const part = (due?.paid_amount ?? 0) > 0;
    const days = Math.abs(clock.days);
    const detail = !dueDate ? null
      : overdue ? `since ${formatDate(dueDate)} · ${days} ${dayWord(days)}`
      : clock.kind === "due_today" ? "due today"
      : `by ${formatDate(dueDate)}`;
    return {
      kind: part ? "part_paid" : overdue ? "overdue" : "due",
      tone: late ? "danger" : "warning",
      label: part ? `Part-paid · ${rupee(owed)} due` : `Due ${rupee(owed)}`,
      detail,
      owed,
      overdue,
    };
  }

  if (sub.status === "cancelled" || sub.status === "expired") return quiet("Ended");

  const req = openRequest(renewalQuote ?? undefined);
  if (req) {
    const sent = ymd(req.created_date) ?? ymd(req.created_at);
    return {
      kind: "request_sent",
      tone: "warning",
      label: sent ? `Request sent ${formatDate(sent)}` : "Request sent",
      detail: req.amount ? `${rupee(req.amount)} renewal` : null,
      owed: 0,
      overdue: false,
    };
  }

  const elsewhere = ymd(sub.billed_externally_until);
  if (elsewhere && elsewhere >= today) return quiet("Billed elsewhere", `till ${formatDate(elsewhere)}`);

  if (period) {
    if (period.invoice_id) {
      return { kind: "paid", tone: "success", label: `Paid till ${formatDate(period.period_end)}`, detail: null, owed: 0, overdue: false };
    }
    const billOn = ymd(period.bill_on);
    return {
      kind: "no_bill",
      tone: "muted",
      label: "No bill for this period",
      detail: billOn && billOn > today ? `bills on ${formatDate(billOn)}` : `period from ${formatDate(period.period_start)}`,
      owed: 0,
      overdue: false,
    };
  }

  const renewal = ymd(sub.renewal_date);
  const hasBill = !!(sub.quote_id || sub.renewal_quote_id);
  if (renewal && renewal >= today && hasBill) {
    return { kind: "paid", tone: "success", label: `Paid till ${formatDate(renewal)}`, detail: null, owed: 0, overdue: false };
  }
  return {
    kind: "no_bill",
    tone: "muted",
    label: "No bill for this period",
    detail: renewal && renewal < today ? `term ended ${formatDate(renewal)}` : null,
    owed: 0,
    overdue: false,
  };
}

/** R-2382: the Payment filter chips — "" = all. */
export const PAYMENT_FILTERS = ["", "paid", "due", "overdue"] as const;
export type PaymentFilter = (typeof PAYMENT_FILTERS)[number];

export function matchesPaymentFilter(p: PaymentStatus, f: PaymentFilter): boolean {
  if (f === "paid") return p.kind === "paid";
  if (f === "due") return p.owed > 0;
  if (f === "overdue") return p.overdue;
  return true;
}

/** Chip counts over the rows the other filters leave — the number is what a click shows. */
export function paymentFilterCounts(rows: readonly PaymentStatus[]): Record<Exclude<PaymentFilter, "">, number> {
  let paid = 0, due = 0, overdue = 0;
  for (const p of rows) {
    if (matchesPaymentFilter(p, "paid")) paid++;
    if (matchesPaymentFilter(p, "due")) due++;
    if (matchesPaymentFilter(p, "overdue")) overdue++;
  }
  return { paid, due, overdue };
}

/** One CSV cell: "Due ₹14,406 (since 15 Sep 2026 · 48 days)". */
export function paymentStatusText(p: PaymentStatus): string {
  return p.detail ? `${p.label} (${p.detail})` : p.label;
}
