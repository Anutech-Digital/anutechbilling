/**
 * R-2192 (G-ZOHO, 7 Nov 2026) — "is this the same money?" with the ₹1 tolerance.
 *
 * Banks, gateways and Zoho round differently: ₹2,534.73 on the bank line is the ₹2,535 invoice,
 * ₹13,105 in is the ₹13,106 receipt. A difference of up to ₹1 is a round-off (booked
 * automatically — P&L "Bank Charges", R-2098's bank_receipt_round_offs), never a part payment
 * or an advance. More than ₹1 stays the owner's call (TDS / part / round-off ≤ ₹50 / bank charge).
 *
 * The SQL side uses the same ₹1: suggest_bank_transaction_matches (a receipt within ₹1 of the
 * line is 'high' when no receipt has the exact amount) and bank_line_receipt_round_off
 * (migration 20261107183500_r2192_small_receipt_differences).
 */

/** The automatic round-off tolerance, in rupees. */
export const ROUND_OFF_AUTO = 1;

/** Compared in paise, so float noise (2534.73 − 2535) never decides. */
const paise = (r: number) => Math.round(r * 100);

/** True when a and b (rupees, may carry paise) are at most `tol` rupees apart. */
export function sameMoney(a: number, b: number, tol: number = ROUND_OFF_AUTO): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(paise(a) - paise(b)) <= paise(tol);
}

/** Same money but not equal to the paisa — the gap is booked as a round-off. */
export function roundOffGap(a: number, b: number): boolean {
  return paise(a) !== paise(b) && sameMoney(a, b);
}
