/**
 * R-1917 — one way for a vendor's money-out line (R-1906 audit B8).
 *
 * When the Reconcile sheet knows the vendor of a debit line (guessed or picked in
 * DebitPayForSection), paying that vendor's open items is THE way. "Book as expense" for the same
 * vendor is refused when one of its open items equals the line — booking it would leave the bill
 * open and count the cost twice. The SQL guard in book_bank_txn_as_expense applies the same rule
 * (migration 20261025155521_r1917_book_expense_vendor_guard).
 */
import { formatDate, rupee } from "@/lib/utils";
import { isRecorded, type VendorOpenItem } from "@/lib/banking/debit-pay-for";

/** The vendor the sheet's vendor section is on, with its open items (bills + recorded payments). */
export interface VendorFocus {
  vendorId: string | null;
  vendorName: string;
  openItems: readonly VendorOpenItem[];
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toUpperCase();

export const sameVendor = (a: string, b: string) => norm(a) !== "" && norm(a) === norm(b);

/** An open item this bank line would settle exactly (gross, or after the TDS already on it). */
export const settlesExactly = (i: VendorOpenItem, debit: number) =>
  i.amount_due === debit || (!isRecorded(i) && i.amount_due - (i.tds_amount ?? 0) === debit);

const billName = (i: VendorOpenItem) => i.bill_no ?? (i.source === "vendor_bill" ? "(COGS bill)" : "(expense bill)");

/**
 * blocked = an open item equals the line (the SQL refuses it too); otherwise a note naming the
 * vendor's other open bills. null = the expense form is not for the focused vendor, or it has
 * nothing open.
 */
export function expenseGuard(
  focus: VendorFocus | null,
  expenseVendor: string,
  debit: number,
): { blocked: boolean; message: string; item: VendorOpenItem } | null {
  if (!focus || !focus.openItems.length || !sameVendor(expenseVendor, focus.vendorName)) return null;
  const exact = [...focus.openItems].sort((a, b) => Number(isRecorded(b)) - Number(isRecorded(a)))
    .find((i) => settlesExactly(i, debit));
  if (exact) {
    const message = isRecorded(exact)
      ? `${focus.vendorName} bill ${billName(exact)} — ${rupee(exact.amount_due)} is already recorded as paid${exact.paid_on ? ` on ${formatDate(exact.paid_on)}` : ""}. Match this line to it with Record payment above instead of booking a new expense, or the cost is counted twice.`
      : `${focus.vendorName} has an open bill ${billName(exact)} for ${rupee(exact.amount_due)} — pay it with Record payment above instead of booking a new expense, or the cost is counted twice.`;
    return { blocked: true, message, item: exact };
  }
  const bills = focus.openItems.filter((i) => !isRecorded(i));
  if (!bills.length) return null;
  const list = bills.slice(0, 3).map((i) => `${billName(i)} ${rupee(i.amount_due)}`).join(", ");
  return {
    blocked: false,
    message: `${focus.vendorName} has ${bills.length === 1 ? "an open bill" : `${bills.length} open bills`} (${list}${bills.length > 3 ? ", …" : ""}). If this line pays ${bills.length === 1 ? "it" : "any of them"}, use Record payment above.`,
    item: bills[0],
  };
}
