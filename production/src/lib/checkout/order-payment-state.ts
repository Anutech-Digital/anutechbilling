/**
 * R-1624 (24 Oct 2026) — the ONE mapping from a quote's payment_status to what a buyer is told.
 *
 * The Workspace thanks page treated only 'received' as paid, so every order whose GST invoice
 * had been issued (record_payment → invoice → payment_status 'invoiced') read "Order placed ·
 * Partially paid" to a buyer who had paid in full.
 *
 * 'invoiced' says an invoice exists, not how much came in: a part-paid quote can be invoiced
 * too (the quote page's "Customer paid X of Y — record the balance"). So for 'invoiced' the
 * answer comes from the money actually received against the quote's total, and with either
 * figure unknown it never claims "paid in full". Money correctness first: a wrong "Paid" is
 * worse than a cautious one.
 *
 *   received                         → paid       (record_payment sets it only when settled)
 *   partial                          → part-paid
 *   invoiced, received ≥ total       → paid
 *   invoiced, 0 < received < total   → part-paid  (also: total unknown but something came in)
 *   invoiced, nothing / unknown      → pending
 *   anything else                    → pending
 */
export type OrderPaymentState = "paid" | "part-paid" | "pending";

export interface OrderPaymentFacts {
  /** quotes.payment_status */
  paymentStatus: string | null | undefined;
  /** The quote's total, in rupees. */
  amount: number | null | undefined;
  /** Sum of the quote's received payments (payments.amount — what they settle), in rupees; null when not read. */
  received: number | null | undefined;
}

export function orderPaymentState({ paymentStatus, amount, received }: OrderPaymentFacts): OrderPaymentState {
  if (paymentStatus === "received") return "paid";
  if (paymentStatus === "partial") return "part-paid";
  if (paymentStatus === "invoiced") {
    const got = typeof received === "number" && Number.isFinite(received) ? received : null;
    const total = typeof amount === "number" && Number.isFinite(amount) ? amount : null;
    if (got === null || got <= 0) return "pending";
    if (total !== null && total > 0 && got >= total) return "paid";
    return "part-paid";
  }
  return "pending";
}
