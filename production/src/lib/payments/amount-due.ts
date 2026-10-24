/**
 * What is actually still owed on an invoice.
 *
 * THIS IS A MONEY FUNCTION. Getting it wrong in one direction asks a customer
 * to pay again for something they have already paid — the single worst bug this
 * product can ship, because it costs the customer real money and costs the
 * reseller the relationship. Getting it wrong in the other direction asks for
 * too little, which is merely annoying and recoverable. So when a value is
 * missing or contradictory, this function biases toward asking for LESS.
 *
 * Two independent things reduce the balance, and they are stored separately:
 *
 *   1. `net_payable` = amount − adjusted advances (migration 0005). Advances are
 *      money taken BEFORE the invoice existed, folded in when it was raised.
 *   2. `paid_amount` = receipts against the invoice AFTER it was raised. Today
 *      only project-milestone receipts land here, via the trigger in migration
 *      0184, whose own column comment states the rule this file implements:
 *      "Outstanding = amount - paid_amount unless status=paid".
 *
 * Subtracting only one of the two — which is what every caller did before this
 * file existed — overstates the balance by the other. In production right now
 * that is INV-ET-2026-27-0013: ₹6,85,000 invoiced, ₹5,40,000 already received,
 * and `net_payable` still reading the full ₹6,85,000.
 *
 * The two are disjoint in practice (advances are consumed at invoice creation;
 * project receipts arrive later), so subtracting both is not double-counting.
 */

/** Only the fields that bear on the balance — any invoice-shaped row will do. */
export interface InvoiceBalanceFields {
  amount?: number | null;
  net_payable?: number | null;
  paid_amount?: number | null;
  status?: string | null;
  /** R-1635: set when the owner wrote the invoice off (bad debt) — nothing is owed any more. */
  written_off_at?: string | null;
}

/**
 * Rupees still owed. Never negative, never NaN. Returns 0 whenever the invoice
 * is settled or cancelled, or when the numbers are unusable — and 0 means
 * "don't ask for money", which is the safe direction.
 */
export function invoiceAmountDue(inv: InvoiceBalanceFields): number {
  // `paid` and `void` are terminal: no balance regardless of the arithmetic.
  // Checked first so a stale number can never resurrect a settled invoice —
  // INV-ET-2026-27-0001 is exactly that case (fully paid, `net_payable` still
  // showing the full ₹5,40,000).
  const status = (inv.status ?? "").toLowerCase();
  if (status === "paid" || status === "void") return 0;
  /* R-1635: written off — the invoice stays issued (same status and money columns), but the
     owner decided not to collect it, so no screen, cron or reminder asks for it. */
  if (inv.written_off_at) return 0;

  const gross = num(inv.net_payable) ?? num(inv.amount);
  if (gross === null) return 0;   // unknown total → ask for nothing

  return Math.max(0, gross - (num(inv.paid_amount) ?? 0));
}

function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Quotes
// ─────────────────────────────────────────────────────────────────────────────

/** Only the fields that bear on whether a quote is still collectable. */
export interface QuoteBalanceFields {
  amount?: number | null;
  payment_amount?: number | null;
  payment_status?: string | null;
  /** Billing currency (migration 0153). 'INR' for domestic. */
  currency?: string | null;
}

/**
 * Rupees still collectable against a QUOTE, for a scan-to-pay QR.
 *
 * A quote is not an invoice and the rules differ in two ways that both matter:
 *
 * 1. CURRENCY. UPI settles in rupees and nothing else. A USD quote for $500 with
 *    `am=500.00` in the intent is not a $500 request — every UPI app reads it as
 *    ₹500. That is a silently wrong amount on a real payment, so a non-INR quote
 *    gets no QR at all rather than a QR that is 98% wrong.
 *
 * 2. WHO OWNS THE ASK. Once a quote has been invoiced, the INVOICE is the payable
 *    document and carries its own QR with its own outstanding balance, computed
 *    from advances and receipts. A QR on the quote as well would be a second
 *    document asking for the same money at a stale amount — the clearest possible
 *    route to being paid twice. So `invoiced` yields nothing here.
 *
 * Returns 0 whenever nothing should be asked for, and 0 means "print no QR".
 */
export function quoteAmountDue(q: QuoteBalanceFields): number {
  // UPI is rupees-only. Absent currency means the pre-0153 default, INR.
  const currency = (q.currency ?? "INR").trim().toUpperCase();
  if (currency !== "INR") return 0;

  // Only a quote still waiting to be paid is collectable. 'received' is settled;
  // 'invoiced' has handed the ask to the invoice; anything unrecognised is not
  // assumed to be collectable.
  const status = (q.payment_status ?? "none").toLowerCase();
  if (status !== "none" && status !== "awaiting" && status !== "partial") return 0;

  const total = num(q.amount);
  if (total === null) return 0;

  return Math.max(0, total - (num(q.payment_amount) ?? 0));
}
