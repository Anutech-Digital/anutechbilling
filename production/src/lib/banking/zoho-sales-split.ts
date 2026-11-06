/**
 * R-2518 (6 Nov 2026) — one bank receipt that paid SEVERAL Zoho invoices is booked as one app sale per
 * Zoho invoice, each with its own lines, GST and Zoho number (invoices.external_number, R-2360's guard).
 *
 * Staging (a client company): UPI ₹6,294 = Zoho INV/26-27/0516 ₹3,243 + INV/26-27/0517 ₹3,051. Find in Zoho and the
 * bulk "Reconcile from Zoho" put all four lines on ONE sale with no Zoho number. Now each line keeps
 * the Zoho invoice it came from (SaleLine.zohoInvoice) and Save sends one sale per invoice through
 * reconcile_bank_credit_split (p_sale = an array — migration 20261106043700, R-2098's model).
 *
 * Pure: no I/O. The amounts follow the SQL twin bank_sale_split_amounts: each sale in full; more money
 * is the customer's advance, less leaves the LAST sale part-paid (its balance stays due — TDS or a short
 * payment is recorded on that invoice). Nothing is written off on its own (review: a ₹34 shortfall is
 * a due, not Bank Charges).
 */
import type { SplitRest } from "@/lib/banking/credit-pay-for-multi";
import type { SaleLine } from "@/lib/banking/credit-pay-for";

export interface ZohoSaleGroup<L extends Pick<SaleLine, "zohoInvoice"> = SaleLine> {
  /** Zoho's invoice number, as Zoho has it. */
  externalNumber: string;
  lines: L[];
}

const key = (n: string) => n.trim().toUpperCase();

/**
 * The lines grouped by their Zoho invoice, in first-seen order — or null when this is not a
 * several-invoice sale: fewer than two invoices, or any line without its invoice (a line the owner
 * added by hand) — then it is ONE sale, as before.
 */
export function zohoInvoiceGroups<L extends Pick<SaleLine, "zohoInvoice">>(lines: readonly L[]): ZohoSaleGroup<L>[] | null {
  if (lines.length === 0 || lines.some((l) => !l.zohoInvoice?.trim())) return null;
  const groups: ZohoSaleGroup<L>[] = [];
  for (const l of lines) {
    const g = groups.find((x) => key(x.externalNumber) === key(l.zohoInvoice!));
    if (g) g.lines.push(l);
    else groups.push({ externalNumber: l.zohoInvoice!.trim(), lines: [l] });
  }
  return groups.length >= 2 ? groups : null;
}

export interface ZohoSalesPlan {
  /** What each sale gets from the bank line (whole rupees), in the groups' order. */
  amounts: number[];
  rest: SplitRest | null;
  /** The last sale stays part-paid by this much (0 = every sale settled in full). */
  shortOnLast: number;
  /** Why it cannot be saved this way; null = it can. */
  problem: string | null;
}

/** Each sale's total → what the bank credit puts on each (bank_sale_split_amounts' rule). */
export function zohoSalesPlan(totals: readonly number[], credit: number): ZohoSalesPlan {
  const amounts = totals.map((t) => Math.max(0, Math.round(t)));
  const sum = amounts.reduce((a, b) => a + b, 0);
  const got = Math.round(credit);
  const diff = got - sum;
  if (amounts.some((a) => a <= 0)) return { amounts, rest: null, shortOnLast: 0, problem: "A Zoho invoice has no amount — reconcile this line by hand." };
  if (diff === 0) return { amounts, rest: null, shortOnLast: 0, problem: null };
  if (diff > 0) return { amounts, rest: "advance", shortOnLast: 0, problem: null };
  const last = amounts[amounts.length - 1] + diff;
  if (last <= 0) {
    return { amounts, rest: null, shortOnLast: 0, problem: `The money (₹${got}) does not reach the last Zoho invoice — reconcile this line by hand.` };
  }
  return { amounts: [...amounts.slice(0, -1), last], rest: null, shortOnLast: -diff, problem: null };
}
