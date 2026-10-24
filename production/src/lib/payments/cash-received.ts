/**
 * R-1565 (18 Oct 2026): the money that actually came in on a sales payment.
 *
 * `payments.amount` is what the payment SETTLES on its quote / invoice. When the customer's
 * advance credit pays part of it, record_desk_payment writes amount = cash + credit and now
 * also `credit_applied` = the credit part. That credit was already counted as money received
 * on the payment that created it (record_payment's overpayment branch), so every "money in"
 * total — Collected, the receipt voucher, GSTR-1 11A advances, cash / bank — reads
 * `amount − credit_applied`. Settlement (paid_amount, outstanding, net payable) keeps `amount`.
 *
 * A row read without the column (older select, or before the migration) counts as all cash,
 * which is what every reader assumed until now.
 */
export interface SettledPayment {
  amount: number;
  credit_applied?: number | null;
}

/** Rupees of real money received on this payment (never negative, never above `amount`). */
export function cashReceived(p: SettledPayment): number {
  const amount = p.amount ?? 0;
  const credit = Math.min(Math.max(p.credit_applied ?? 0, 0), Math.max(amount, 0));
  return amount - credit;
}
