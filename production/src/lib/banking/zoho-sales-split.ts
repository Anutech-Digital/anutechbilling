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
import type { SplitRest, SplitSaleInput } from "@/lib/banking/credit-pay-for-multi";
import { saleBillingCycle, saleLinesPayload, saleMakesSubscription, saleSchedule, type SaleLine } from "@/lib/banking/credit-pay-for";
import type { BillingCycle } from "@/lib/supabase/database.types";

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

/** The Reconcile sheet's several-Zoho-invoice sale: each group, its billing term and total, and the plan. */
export interface ZohoSheetSales {
  sales: Array<{ group: ZohoSaleGroup; cycle: BillingCycle; total: number }>;
  plan: ZohoSalesPlan;
}

/** R-2518: the sheet's lines → one sale per Zoho invoice (null = one sale, as before). */
export function zohoSheetSales(lines: readonly SaleLine[], o: { payCycle: BillingCycle; gstRate: number; start: string; credit: number }): ZohoSheetSales | null {
  const groups = zohoInvoiceGroups(lines);
  if (!groups) return null;
  const sales = groups.map((g) => {
    const cycle = saleBillingCycle(g.lines, o.payCycle);
    return { group: g, cycle, total: saleSchedule(g.lines, o.gstRate, cycle, o.start).dueNow };
  });
  return { sales, plan: zohoSalesPlan(sales.map((s) => s.total), o.credit) };
}

/** Why the sheet cannot save these sales together (null = it can). */
export function zohoSheetProblem(z: ZohoSheetSales | null, o: { tdsAmount: number; belowCost: boolean }): string | null {
  if (!z) return null;
  if (z.plan.problem) return z.plan.problem;
  /* R-2397's rule on several sales: the server refuses them when one is below cost (one approval at a time). */
  if (o.belowCost) return "A line is priced below cost, so these Zoho invoices cannot be booked together. Fix the price, or remove the other invoice's lines and send this sale for approval on its own.";
  if (o.tdsAmount > 0) return "TDS cannot be recorded while booking several Zoho invoices at once. Choose part payment (the rest stays due on the last invoice), then record the TDS on that invoice.";
  return null;
}

/** The split RPC's sales (SplitSaleInput[]) — each with its own lines, term, subscription and Zoho number. */
export function zohoSplitSales(z: ZohoSheetSales, o: { makeSubs: boolean; subStart: string | null; subRenewal: string | null }): SplitSaleInput[] {
  return z.sales.map((s, k) => {
    const sub = o.makeSubs && saleMakesSubscription(s.group.lines);
    return {
      lines: saleLinesPayload(s.group.lines), billingCycle: s.cycle, createSubscription: sub,
      subStart: sub ? o.subStart : null, subRenewal: sub ? o.subRenewal : null,
      amount: z.plan.amounts[k], externalNumber: s.group.externalNumber,
    };
  });
}
