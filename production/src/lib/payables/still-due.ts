/**
 * R-1952 (26 Oct 2026) — the one rule for paying an expense (vendor) bill:
 *
 *     still due = amount − tds_amount − advance_applied − paid_amount
 *
 * The TDS goes to the government, not the vendor; the advance applied (R-1913) and the bank parts
 * (R-1915) are already settled. Every place that PAYS the bill uses this — bulk Mark paid, a
 * payment run (payment_run_outstanding in migration 20261025235259_r1952), the petty-cash debit of
 * Mark paid — and so does the Reconcile button of a bill marked paid but not yet matched to its
 * bank line: that line is for this amount, never the whole bill. Same as the Balance Sheet's
 * expenses_payable / expenses_paid_unbanked.
 */
export interface ExpenseDueLike {
  amount: number | null;
  tds_amount?: number | null;
  advance_applied?: number | null;
  paid_amount?: number | null;
}

export function expenseCashDue(e: ExpenseDueLike): number {
  return Math.max(0, (e.amount ?? 0) - (e.tds_amount ?? 0) - (e.advance_applied ?? 0) - (e.paid_amount ?? 0));
}

/** What already came off the bill, for a "(bill ₹5,000 − advance ₹3,000)" note. Empty when nothing did. */
export function expenseDueNote(e: ExpenseDueLike, rupee: (n: number) => string): string {
  const parts: string[] = [];
  if ((e.tds_amount ?? 0) > 0) parts.push(`TDS ${rupee(e.tds_amount ?? 0)}`);
  if ((e.advance_applied ?? 0) > 0) parts.push(`advance ${rupee(e.advance_applied ?? 0)}`);
  if ((e.paid_amount ?? 0) > 0) parts.push(`already paid ${rupee(e.paid_amount ?? 0)}`);
  return parts.length ? `bill ${rupee(e.amount ?? 0)} − ${parts.join(" − ")}` : "";
}
