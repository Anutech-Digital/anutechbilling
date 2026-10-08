/**
 * R-060 — "overdue" is DERIVED, not stored.
 *
 * ─── WHAT WAS WRONG ─────────────────────────────────────────────────────────
 * `invoices.status` has an `overdue` value, `/invoices` has an Overdue tab, an Overdue
 * KPI tile and an "Overdue {n}d" badge — and **nothing in the product ever writes that
 * value**. Not a trigger, not an RPC, not a cron, not a route. `invoices.overdue_days`
 * is the same: `default 0`, never updated. Grepped across `src/` and
 * `supabase/migrations/`; every other hit is a different table's own overdue (tasks,
 * follow-ups, expenses, GBP replies).
 *
 * So the tab was permanently empty and the KPI permanently ₹0 while invoices went
 * months past their due date. Worse than an error, because it reads as good news: the
 * one screen a reseller opens to ask "who owes me money and is late?" answered "nobody"
 * — AGENTS.md §2, a failure wearing the costume of a plausible value.
 *
 * Meanwhile the dunning cron (`api/cron/invoice-dunning`) works entirely off `due_date`
 * and has been correctly emailing those customers the whole time. The customer was being
 * chased; the reseller could not see it. That gap is the actual bug.
 *
 * ─── WHY DERIVED AND NOT A DAILY CRON ───────────────────────────────────────
 * The card allowed either ("overdue status daily cron ya view se"). A cron writing
 * `status = 'overdue'` every morning has one failure mode that this shape does not: when
 * it stops running, every screen keeps rendering yesterday's answer and looks completely
 * normal. Nothing turns red. That is the same class of silent-wrong this file exists to
 * remove, so re-introducing it to fix it would be a poor trade. A derived value cannot
 * go stale — it is recomputed from `due_date` on every render, and `due_date` is frozen
 * on the issued invoice (20260823090000).
 *
 * The cost of deriving is that `overdue` is display-only: a Postgres query that filters
 * `status = 'overdue'` still finds nothing. Every such query in the tree already asks for
 * `('pending', 'overdue')` together — aging, the GST report, the accounting folder counts
 * — so all of them are already correct. If a report ever needs it server-side, that is a
 * view over `due_date`, not a column somebody has to remember to update.
 *
 * ─── THE ARITHMETIC MATCHES THE DUNNING ENGINE ON PURPOSE ───────────────────
 * `invoiceAmountDue` (net_payable − paid_amount), IST midnights, no due date means never
 * overdue — the same three rules as the dunning cron. If the badge and the reminder email
 * disagreed about which invoices are late, the reseller would be arguing with their own
 * software in front of a customer.
 *
 * R-371 (7 Oct 2026): both places used to compute `amount − paid_amount`, ignoring
 * `net_payable` (lowered by credit notes and advances adjusted at issue), so an invoice
 * fully covered that way read as overdue and was chased for the full amount. Fixed in
 * both at once, through the one shared function in lib/payments/amount-due.
 */
import { istToday } from "@/lib/dates/ist";
import { invoiceAmountDue } from "@/lib/payments/amount-due";

/** The columns an overdue decision needs. Structural, so any invoice-shaped row fits. */
export interface OverdueInvoice {
  status:       string;
  due_date:     string | null;
  amount:       number;
  /** amount less credit notes / advances adjusted at issue. Absent → falls back to amount. */
  net_payable?: number | null;
  paid_amount?: number | null;
}

/** Statuses where a due date means nothing: the money is settled or the document isn't real. */
const SETTLED = new Set(["paid", "void", "draft", "cancelled"]);

/**
 * Is this invoice past its due date with money still owed, as of `today` (IST)?
 *
 * `today` is a `YYYY-MM-DD` string and the comparison is a string compare, which is
 * exact for ISO dates and needs no Date objects — the timezone question is answered
 * once, by `istToday()`, instead of at every call site.
 */
export function invoiceIsOverdue(inv: OverdueInvoice, today: string = istToday()): boolean {
  /* A stored 'overdue' is still honoured. Nothing writes it today, but a value that
     arrives from a future cron or a data import must not be argued with. */
  if (inv.status === "overdue") return true;
  if (SETTLED.has(inv.status)) return false;
  /* No due date is NOT "overdue since forever" — it is an invoice nobody gave a
     deadline. Inventing one here would put customers in the chase list on terms they
     were never told (the same rule decideDunning states). */
  if (!inv.due_date) return false;
  if (inv.due_date >= today) return false;
  return invoiceAmountDue(inv) > 0;
}

/**
 * Whole days past the due date, 0 when not overdue.
 *
 * Replaces the `invoices.overdue_days` column in the badge. That column is `default 0`
 * and has no writer, so "Overdue 0d" was the only thing it could ever have rendered.
 */
export function invoiceOverdueDays(inv: OverdueInvoice, today: string = istToday()): number {
  if (!inv.due_date || !invoiceIsOverdue(inv, today)) return 0;
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${inv.due_date}T00:00:00Z`);
  return Math.max(0, Math.round(ms / 86_400_000));
}

/**
 * Which tab an invoice belongs in: its status, except that an unpaid invoice past its
 * due date belongs in Overdue.
 *
 * One function so the tab filter, the tab counts and the KPI tile cannot drift — the
 * three of them disagreeing about the same word is how "Overdue (3)" ends up over an
 * empty table.
 */
export function invoiceBucket(inv: OverdueInvoice, today: string = istToday()): string {
  return invoiceIsOverdue(inv, today) ? "overdue" : inv.status;
}
