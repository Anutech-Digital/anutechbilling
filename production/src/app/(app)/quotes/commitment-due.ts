/**
 * R-2046 (28 Oct 2026, Pardeep) — "Commitment due" on the Quotes list.
 *
 * After R-2044 a part of a subscription billed in parts (monthly / quarterly / half-yearly) is a
 * PAYMENT REQUEST — a quote with quotes.subscription_billing_id set — and its tax invoice is raised
 * only when it is paid. So an unpaid part is not in receivables; this list is where the owner sees
 * that committed money: customer, period, amount, days overdue, and the two next steps (Record
 * payment / Customer stopped — the same dialogs as on the quote page).
 *
 * A request is in the list while it is:
 *   - a part request (subscription_billing_id set — ordinary quotes are out);
 *   - open: status sent / viewed / accepted ("Customer stopped" = stop_part_payment_request sets
 *     status rejected, so a stopped request leaves; expired / draft are not open either);
 *   - not invoiced (invoice_id null — paying it raises the invoice, tg_payments_part_request_invoice);
 *   - not paid in full: payment_status not received / invoiced AND something is still due
 *     (open_balance from quote_open_balances when loaded, else amount − payment_amount).
 *     A part-paid request stays, for what is still due.
 *
 * Days overdue count from the part's bill date (subscription_billings.bill_on — the request is
 * prepaid, sent and due that day; label-and-logic-check §2d), never from the quote's creation.
 */
import { daysBetweenISO } from "@/lib/dates/ist";

/** URL choice ?commitment=due on /quotes ("" = the ordinary list). */
export const COMMITMENT_CHOICES = ["", "due"] as const;

const OPEN_STATUSES = new Set(["sent", "viewed", "accepted"]);
const PAID_STATUSES = new Set(["received", "invoiced"]);

/** The quote fields this list reads (a Quote row read with select("*") plus open_balance). */
export interface CommitmentQuote {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  amount: number | null;
  payment_amount: number | null;
  payment_status: string | null;
  status: string;
  invoice_id: string | null;
  /** R-2044 column; not in the generated types yet, so it may be absent on the type. */
  subscription_billing_id?: string | null;
  line_items: unknown;
  open_balance?: number | null;
}

/** ₹ still due on the request (whole rupees, never negative). */
export function commitmentStillDue(q: CommitmentQuote): number {
  if (typeof q.open_balance === "number") return Math.max(0, Math.round(q.open_balance));
  return Math.max(0, Math.round((q.amount ?? 0) - (q.payment_amount ?? 0)));
}

export function isCommitmentDue(q: CommitmentQuote): boolean {
  if (!q.subscription_billing_id) return false;
  if (!OPEN_STATUSES.has(q.status)) return false;
  if (q.invoice_id) return false;
  if (q.payment_status && PAID_STATUSES.has(q.payment_status)) return false;
  return commitmentStillDue(q) > 0;
}

export interface CommitmentDueLabel {
  /** Days past the bill date; 0 = due today; negative = not yet due; null = no bill date found. */
  days: number | null;
  text: string;
  tone: "overdue" | "today" | "upcoming" | "unknown";
}

export function commitmentDueLabel(billOn: string | null | undefined, todayISO: string): CommitmentDueLabel {
  if (!billOn) return { days: null, text: "Due date not found", tone: "unknown" };
  const days = daysBetweenISO(billOn, todayISO);
  if (days > 0) return { days, text: `${days} day${days === 1 ? "" : "s"} overdue`, tone: "overdue" };
  if (days === 0) return { days: 0, text: "Due today", tone: "today" };
  const n = -days;
  return { days, text: `Due in ${n} day${n === 1 ? "" : "s"}`, tone: "upcoming" };
}

export interface CommitmentDueRow {
  quoteId: string;
  customerId: string | null;
  customerName: string;
  /** The part line as on the request: "Advance payment for Q2 · 28 Oct–27 Jan 2027". */
  period: string;
  /** The request's amount incl. GST, as on the quote. */
  amount: number;
  stillDue: number;
  partPaid: boolean;
  billOn: string | null;
  due: CommitmentDueLabel;
}

function periodOf(lineItems: unknown): string {
  const first = Array.isArray(lineItems) ? (lineItems[0] as { name?: unknown } | undefined) : undefined;
  return typeof first?.name === "string" && first.name.trim() ? first.name.trim() : "—";
}

/**
 * The list, most overdue first (unknown due dates last), and the total still due over it.
 * `billOnByBillingId` maps subscription_billings.id → bill_on.
 */
export function commitmentDueRows(
  quotes: readonly CommitmentQuote[],
  billOnByBillingId: ReadonlyMap<string, string>,
  todayISO: string,
): { rows: CommitmentDueRow[]; total: number } {
  const rows = quotes.filter(isCommitmentDue).map((q): CommitmentDueRow => {
    const billOn = billOnByBillingId.get(q.subscription_billing_id as string) ?? null;
    const amount = Math.round(q.amount ?? 0);
    const stillDue = commitmentStillDue(q);
    return {
      quoteId: q.id,
      customerId: q.customer_id,
      customerName: (q.customer_name ?? "").trim() || "—",
      period: periodOf(q.line_items),
      amount,
      stillDue,
      partPaid: stillDue < amount,
      billOn,
      due: commitmentDueLabel(billOn, todayISO),
    };
  });
  rows.sort((a, b) => {
    const da = a.due.days ?? Number.NEGATIVE_INFINITY;
    const db = b.due.days ?? Number.NEGATIVE_INFINITY;
    return db - da || a.quoteId.localeCompare(b.quoteId);
  });
  return { rows, total: rows.reduce((s, r) => s + r.stillDue, 0) };
}
