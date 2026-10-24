/**
 * R-1709 (24 Oct 2026) — an invoice's payment state, read from MONEY, in one place.
 *
 * ─── WHAT WAS WRONG (billing audit, 20 Oct) ─────────────────────────────────
 * · "Paid this month" added the full amount of every invoice whose status was 'paid'
 *   (kpis.ts:76). A credit note that covers the balance also sets status = 'paid'
 *   (issue_credit_note_core, 20261018171947_r1563_credit_note_refund.sql:217-219), so T-L5's
 *   ₹38,232 counted as collected although not a rupee came in.
 * · The same invoice's badge said "Paid".
 * · The Partial chip counted only invoices with advances adjusted (kpis.ts:94) while the row
 *   badge also counted receipts after the invoice (paid_amount) — INV-0007's row said
 *   "Partial", the chip said "Partial 0".
 *
 * ─── THE MONEY ──────────────────────────────────────────────────────────────
 *   money in     = paid_amount (receipts after the invoice) + advances adjusted at issue
 *                  (adjusted_advances[].amount) — the two are disjoint (lib/payments/amount-due.ts)
 *   value        = amount + debit notes − credit notes (what the customer must finally pay)
 *
 *   draft / void                                    → draft / void
 *   paid, credit notes, money in < amount + debit  → credited   (a note, not money, closed it)
 *   paid                                            → paid
 *   written off (not paid)                          → written-off
 *   pending / overdue with any money in             → partial
 *   pending / overdue, nothing in                   → unpaid      (overdue is derived by date — overdue.ts)
 *
 * Older invoices were marked paid without paid_amount (credit_note_refund.sql:170). With no
 * money columns and no credit note they stay "paid", at their value: the status is the only
 * fact there is. Notes not read (`credit_noted` undefined) never produce "credited".
 */

export type InvoicePaymentState = "draft" | "void" | "paid" | "credited" | "written-off" | "partial" | "unpaid";

export interface InvoicePaymentFacts {
  status: string;
  amount: number;
  net_payable?: number | null;
  paid_amount?: number | null;
  /** invoices.adjusted_advances — [{ payment_id, amount, … }] snapshotted at issue. */
  adjusted_advances?: unknown;
  written_off_at?: string | null;
  /** Sum of this invoice's credit notes (₹). Undefined = not read. */
  credit_noted?: number | null;
  /** Sum of this invoice's debit notes (₹). */
  debit_noted?: number | null;
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
};
const paise = (v: number) => Math.round(v * 100);

function advances(inv: InvoicePaymentFacts): unknown[] {
  return Array.isArray(inv.adjusted_advances) ? inv.adjusted_advances : [];
}

/** Money received toward the invoice, before any cap: receipts + advances adjusted at issue. */
function receivedRaw(inv: InvoicePaymentFacts): number {
  const adv = advances(inv).reduce<number>((s, a) => s + num((a as { amount?: unknown } | null)?.amount), 0);
  return (paise(num(inv.paid_amount)) + paise(adv)) / 100;
}

/** What the customer must finally pay: amount + debit notes − credit notes, never below 0. */
export function invoiceValueAfterNotes(inv: InvoicePaymentFacts): number {
  return Math.max(0, paise(num(inv.amount)) + paise(num(inv.debit_noted)) - paise(num(inv.credit_noted))) / 100;
}

export function invoicePaymentState(inv: InvoicePaymentFacts): InvoicePaymentState {
  const status = (inv.status ?? "").toLowerCase();
  if (status === "draft") return "draft";
  if (status === "void") return "void";
  const got = receivedRaw(inv);
  if (status === "paid") {
    const credit = num(inv.credit_noted);
    // ₹1 of rounding tolerated, as quoteIsPaid does.
    if (credit > 0 && got < num(inv.amount) + num(inv.debit_noted) - 1) return "credited";
    return "paid";
  }
  if (inv.written_off_at) return "written-off";
  return got > 0 || advances(inv).length > 0 ? "partial" : "unpaid";
}

/**
 * Rupees that really came in on this invoice — what "Paid this month" adds up.
 * Capped at the value after notes: money paid beyond it became customer credit
 * (credit_note_refund.sql:207-213), not this invoice's money. A legacy paid row with no
 * money columns counts at its value (see above).
 */
export function invoiceMoneyIn(inv: InvoicePaymentFacts): number {
  const state = invoicePaymentState(inv);
  if (state === "draft" || state === "void") return 0;
  const got = receivedRaw(inv);
  if (state === "paid") {
    const value = invoiceValueAfterNotes(inv);
    return got > 0 ? Math.min(got, value) : value;
  }
  return got;
}
