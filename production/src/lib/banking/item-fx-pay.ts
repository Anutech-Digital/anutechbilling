/**
 * R-2466 — Banking → Reconcile → "An open quote / invoice": what paying the picked item does, checked
 * before Save. Pure, no I/O.
 *
 *   · An invoice in a foreign currency (an export sale, R-2425 / R-2427) paid by an inward remittance
 *     in that currency ("INW … USD2000.0@88.5") → R-2427's reconcile_bank_credit_fx_invoice: the
 *     invoice's whole ₹ due is the receipt, the short part × the bank's rate is Bank Charges and the
 *     rest of the ₹ gap is a forex gain / loss. The settlement is fxInvoiceSettlement — the same rule
 *     Reconcile from Zoho plans with and the SQL books with. Booking it in ₹ instead would keep a forex
 *     gain as the customer's credit, so a foreign invoice without a matching remittance is refused.
 *   · A Zoho opening invoice (R-1739) takes no more than its due — its receipt carries no quote, so
 *     there is no customer credit on it (bank_credit_pay_item refuses); the extra goes through
 *     "Several quotes / invoices" + advance.
 */
import { rupee } from "@/lib/utils";
import { formatForeign } from "@/lib/currency";
import { formatRemittance, parseInwardRemittance } from "@/lib/banking/inward-remittance";
import { fxInvoiceSettlement } from "@/lib/integrations/zoho-books/bulk-reconcile-plan";
import type { OpenItem } from "@/lib/banking/credit-pay-for";

/** What reconcile_bank_credit_fx_invoice is sent (the narration's figures) and what it will book. */
export interface ItemFx {
  currency: string;
  /** The bank's ₹ rate (narration). */
  rate: number;
  /** The foreign amount the bank got (narration). */
  foreignAmount: number;
  /** The invoice's own ₹ rate. */
  invoiceRate: number;
  foreignDue: number;
  bankCharges: number;
  /** < 0 = a gain. */
  forex: number;
}

export interface ItemPayPlan { fx: ItemFx | null; problem: string | null }

type PlanItem = Pick<OpenItem, "kind" | "invoice_id" | "quote_id" | "amount_due" | "currency" | "fx_rate">;

export function itemPayPlan(item: PlanItem, line: { description: string | null | undefined; credit: number }, opts: { relink?: boolean } = {}): ItemPayPlan {
  const id = item.invoice_id ?? item.quote_id ?? "This item";
  const cur = (item.currency ?? "").trim().toUpperCase() || "INR";
  const refuse = (problem: string): ItemPayPlan => ({ fx: null, problem });
  if (cur === "INR") {
    if (item.kind === "opening" && line.credit > item.amount_due) {
      return refuse(`${id} is last year's invoice from Zoho with ${rupee(item.amount_due)} due — it takes no more. Choose "Several quotes / invoices" and keep the rest as advance.`);
    }
    return { fx: null, problem: null };
  }
  /* reconcile_bank_credit_fx_invoice pays an INVOICE; a foreign quote booked in ₹ would keep the forex gain as credit. */
  if (!item.invoice_id) return refuse(`${id} is a quote in ${cur} with no invoice yet — an export receipt pays an invoice in ${cur}. Reconcile this line by hand.`);
  if (opts.relink) return refuse(`${id} is in ${cur} — a relink books in ₹ only. Reconcile this line by hand.`);
  const r = parseInwardRemittance(line.description);
  if (!r) return refuse(`${id} is in ${cur}, but this bank line's narration has no ${cur} amount and rate (like "${cur}1024.0@93.6"). Reconcile this line by hand.`);
  if (r.currency !== cur) return refuse(`${id} is in ${cur}, but this money came in ${r.currency}. Reconcile this line by hand.`);
  const invoiceRate = Number(item.fx_rate) || 0;
  if (!(invoiceRate > 0)) return refuse(`${id} is in ${cur} but has no exchange rate in the app. Reconcile this line by hand.`);
  const s = fxInvoiceSettlement(item.amount_due, invoiceRate, r, line.credit);
  if (s.problem) return refuse(s.problem);
  return {
    fx: { currency: cur, rate: r.rate, foreignAmount: r.amount, invoiceRate, foreignDue: s.foreignDue, bankCharges: s.bankCharges, forex: s.forex },
    problem: null,
  };
}

/** "Several quotes / invoices" books each item in ₹ (reconcile_bank_credit_split) — a foreign item is
 *  paid on its own, the R-2427 way. null = no foreign item ticked. */
export function splitFxProblem(items: ReadonlyArray<Pick<OpenItem, "invoice_id" | "quote_id" | "currency">>): string | null {
  const f = items.find((i) => ((i.currency ?? "").trim().toUpperCase() || "INR") !== "INR");
  if (!f) return null;
  return `${f.invoice_id ?? f.quote_id} is in ${(f.currency ?? "").toUpperCase()} — pay it on its own with "An open quote / invoice" (forex and bank charges are booked there). Several items are booked in ₹ only.`;
}

/** One sentence for the sheet: what the export receipt books. */
export function itemFxText(invoiceId: string, fx: ItemFx, rupeeDue?: number): string {
  const due = rupeeDue ?? Math.round(fx.foreignDue * fx.invoiceRate);
  const foreignDue = formatForeign(fx.foreignDue, fx.currency, Number.isInteger(fx.foreignDue) ? 0 : 2);
  const parts = [
    fx.bankCharges > 0 ? `${rupee(fx.bankCharges)} Bank Charges (remitting bank)` : null,
    fx.forex < 0 ? `${rupee(-fx.forex)} forex gain` : fx.forex > 0 ? `${rupee(fx.forex)} forex loss` : null,
  ].filter(Boolean);
  return `Export receipt ${formatRemittance({ currency: fx.currency, amount: fx.foreignAmount, rate: fx.rate })} settles ${invoiceId} in full (${foreignDue} due at ₹${fx.invoiceRate} = ${rupee(due)})`
    + (parts.length ? ` — ${parts.join(" + ")} on the bank line's date.` : ".");
}
