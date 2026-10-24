/**
 * R-1863 — "Money in · no customer yet": unmatched money-in lines with no customer to go on.
 *
 * guessCustomer (lib/banking/credit-pay-for.ts) finds nobody in the narration and there is no
 * certain open-invoice match. These are the receipts someone has to look at one by one; every
 * other unmatched credit already opens the Reconcile sheet with its customer filled in.
 * Pure — the bank page's chip (and any later filter) calls it; never duplicate the rule.
 */
import { guessCustomer, type CustomerLite } from "@/lib/banking/credit-pay-for";

export interface NoCustomerTxn { credit: number; matched_to_type: string | null; description: string | null }
export type InvoiceMatchLite = { customerName: string | null; confidence: string };

/** One line: unmatched, money in, and no customer can be guessed. */
export function isNoCustomerYet(
  txn: NoCustomerTxn,
  customers: readonly CustomerLite[],
  invoiceMatches: ReadonlyArray<InvoiceMatchLite> = [],
): boolean {
  return txn.matched_to_type === null && txn.credit > 0 && guessCustomer(txn, customers, invoiceMatches) === null;
}

/** The lines of a list that are "no customer yet". */
export function noCustomerYet<T extends NoCustomerTxn>(
  txns: readonly T[],
  customers: readonly CustomerLite[],
  invoiceMatchesOf: (t: T) => ReadonlyArray<InvoiceMatchLite> = () => [],
): T[] {
  return txns.filter((t) => isNoCustomerYet(t, customers, invoiceMatchesOf(t)));
}
