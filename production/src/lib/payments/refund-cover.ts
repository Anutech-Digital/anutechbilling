/**
 * R-1563 (18 Oct 2026): how much of a refund on an INVOICED quote is covered by credit notes.
 *
 * A GST tax invoice is never refunded straight — CGST s.34 wants a credit note first. Since
 * R-1566, a credit note that takes the invoice below what the customer already paid turns that
 * excess into open customer credit (source = the note, source_invoice_id = the invoice).
 * refund_payment (20261018171947_r1563_credit_note_refund.sql) then lets the payment be
 * refunded when that credit — plus the payment's own open overpayment credit, which a refund
 * closes anyway — covers the cash going back, and pays that credit out.
 *
 * The Payments screen asks this BEFORE the reason box, so it either says exactly how big a
 * credit note is still needed ("Credit note first") or goes straight on to the refund — it no
 * longer sends the user to the invoice and back to the same dialog. The database decides
 * again on the click (fail-closed); this is only the screen's early answer.
 */
export interface RefundCoverInput {
  /** Cash going back: payment amount − credit_applied (cashReceived). */
  cash: number;
  /** This payment's own open overpayment credit (closed by the refund). */
  ownOpenCredit: number;
  /** Open credit made by credit notes on the quote's invoice. */
  creditNoteCredit: number;
}

export interface RefundCover {
  /** Rupees the credit notes must cover (cash less the payment's own open credit). */
  need: number;
  /** Rupees of credit note still to issue before the refund can be booked (0 = go ahead). */
  gap: number;
}

const rupees = (n: number) => Math.max(0, Math.round(Number.isFinite(n) ? n : 0));

export function refundCover({ cash, ownOpenCredit, creditNoteCredit }: RefundCoverInput): RefundCover {
  const need = Math.max(0, rupees(cash) - rupees(ownOpenCredit));
  return { need, gap: Math.max(0, need - rupees(creditNoteCredit)) };
}

/**
 * R-1682 (19 Oct 2026): the most that can go back WITHOUT another credit note — the open
 * credit-note credit on the invoice, never more than the cash this payment brought in.
 * refund_credit_note_credit (20261019132853) checks the same cap on the click.
 */
export function partialRefundMax({ cash, creditNoteCredit }: { cash: number; creditNoteCredit: number }): number {
  return Math.min(rupees(cash), rupees(creditNoteCredit));
}

/** Why a typed partial-refund amount cannot be booked, or null when it can. */
export function partialRefundProblem(amount: number, max: number): string | null {
  if (!Number.isFinite(amount) || amount <= 0) return "Enter the amount to refund (more than ₹0).";
  if (!Number.isInteger(amount)) return "Whole rupees only — no paise.";
  if (amount > max) return `At most ₹${max.toLocaleString("en-IN")} can be refunded — that is the open credit-note credit.`;
  return null;
}
