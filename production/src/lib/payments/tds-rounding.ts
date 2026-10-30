/**
 * R-2095 (30 Oct 2026, September reconcile): Record balance payment — the customer withheld ₹298 TDS
 * where rate × pre-GST rounds to ₹297 (paise rounding on their side). Bank + ₹297 left ₹1 "due" on a
 * settled bill. When the typed bank amount + TDS at rate misses the balance by exactly ₹1 either way,
 * the TDS is the balance − bank (what the customer really withheld). Never more than ₹1.
 */
export function tdsWithRounding(a: {
  tdsAtRate: number;
  /** Balance still owed on the bill. */
  remaining: number;
  /** ₹ received in bank (typed). */
  bank: number;
  /** Advance credit used on this payment. */
  credit: number;
  /** The bank amount was typed by the user (else it follows remaining − TDS and always matches). */
  bankTyped: boolean;
}): number {
  if (!a.bankTyped || a.tdsAtRate <= 0) return a.tdsAtRate;
  const gap = a.remaining - a.credit - a.bank - a.tdsAtRate;
  return Math.abs(gap) === 1 ? a.tdsAtRate + gap : a.tdsAtRate;
}

/**
 * R-2095 (Sept reconcile): a TDS-only balance receipt (₹0 in bank, the customer's TDS clears the
 * balance) was saved as "Bank transfer ₹21" into HDFC — it looked like bank money and waited in bank
 * reconciliation for a line that never comes. It is saved as method 'other', no bank account, and
 * named "TDS deducted by customer".
 */
export function tdsOnlyReceipt<M extends string>(a: { method: M; bankAccountId: string | null; bank: number; tdsActive: boolean; notes: string | null }):
  { method: M | "other"; bankAccountId: string | null; notes: string | null; tdsOnly: boolean } {
  if (!(a.tdsActive && a.bank === 0)) return { method: a.method, bankAccountId: a.bankAccountId, notes: a.notes, tdsOnly: false };
  return { method: "other", bankAccountId: null, notes: ["TDS deducted by customer", a.notes].filter(Boolean).join(" · "), tdsOnly: true };
}
