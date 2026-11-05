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
 *   · R-1678: the same foreign invoice paid in ₹ (NEFT / Razorpay — no "USD…@" in the narration) is
 *     settled in full too: its whole ₹ due is the receipt and the gap goes to the "Exchange gain / loss
 *     (realised)" ledger — never left due, never TDS. Saved through reconcile_bank_credit_split with
 *     p_rest 'fx' (one item), the rule of splitFxPlan below; more than FX_INR_GAP_SHARE off is refused.
 *   · R-1678: "Several quotes / invoices" pays several invoices of ONE foreign currency from one credit
 *     the same way (splitFxPlan): each in full, the difference split by each invoice's foreign amount.
 *   · A Zoho opening invoice (R-1739) takes no more than its due — its receipt carries no quote, so
 *     there is no customer credit on it (bank_credit_pay_item refuses); the extra goes through
 *     "Several quotes / invoices" + advance.
 */
import { rupee } from "@/lib/utils";
import { formatForeign } from "@/lib/currency";
import { formatRemittance, parseInwardRemittance, remittanceFitsCredit, remittanceInr, type InwardRemittance } from "@/lib/banking/inward-remittance";
import { FX_CHARGES_MAX_SHARE, FX_RATE_MAX_DRIFT, fxInvoiceSettlement } from "@/lib/integrations/zoho-books/bulk-reconcile-plan";
import type { OpenItem } from "@/lib/banking/credit-pay-for";
import { tdsRateFor } from "@/lib/banking/invoice-credit-match";
import { isExportSupply } from "@/lib/gst/place-of-supply";

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

/** R-1678: the ledger an exchange difference is booked to (bank_fx_book_differences; CA to confirm the name). */
export const EXCHANGE_LEDGER = "Exchange gain / loss (realised)";
/** R-1678 → R-1678b (independent review): a ₹ credit more than 5% SHORT of the invoices' ₹ value is not an
 *  exchange difference (TDS, a fee or a part payment); more than due is an advance, never a gain; a
 *  customer in India never gets one. Same rules as reconcile_bank_credit_split (20261106030000). */
export const FX_INR_GAP_SHARE = 0.05;

/** R-1678b: a settlement-gateway credit — its gap is the gateway's fee (with GST ITC), not exchange. */
const GATEWAY_RE = /RAZORPAY|PAYU|STRIPE|CASHFREE/i;

/** The operator's answer for a ₹ credit on foreign invoices: an exchange difference, or a plain ₹ payment. */
export type FxChoice = "fx" | "rupee";

export interface SplitFxPart {
  id: string;
  foreignDue: number;
  /** ₹ due = the receipt booked on it. */
  due: number;
  /** Its share of the bank credit, by its foreign amount. */
  bankShare: number;
  bankCharges: number;
  /** < 0 = a gain. */
  forex: number;
}

/** What reconcile_bank_credit_split with p_rest 'fx' will book. */
export interface SplitFx {
  currency: string;
  foreignDue: number;
  due: number;
  /** The inward remittance on the line, or null for a ₹ credit. */
  remittance: InwardRemittance | null;
  /** R-1678b: a ₹ credit's gap as % of the ₹ due (null with a remittance). */
  gapPct: number | null;
  bankCharges: number;
  forex: number;
  parts: SplitFxPart[];
}

export interface ItemPayPlan {
  fx: ItemFx | null;
  problem: string | null;
  /** R-1678: a foreign invoice paid in ₹ (or a foreign quote) settled in full — saved through the split
   *  with p_rest 'fx'. The sheet offers "book it in ₹" instead (part payment / TDS / advance). */
  splitFx?: SplitFx | null;
}

type PlanItem = Pick<OpenItem, "kind" | "invoice_id" | "quote_id" | "amount_due" | "currency" | "fx_rate">;

export function itemPayPlan(item: PlanItem, line: { description: string | null | undefined; credit: number }, opts: { relink?: boolean; customerCountry?: string | null } = {}): ItemPayPlan {
  const id = item.invoice_id ?? item.quote_id ?? "This item";
  const cur = (item.currency ?? "").trim().toUpperCase() || "INR";
  const refuse = (problem: string): ItemPayPlan => ({ fx: null, problem });
  if (cur === "INR") {
    if (item.kind === "opening" && line.credit > item.amount_due) {
      return refuse(`${id} is last year's invoice from Zoho with ${rupee(item.amount_due)} due — it takes no more. Choose "Several quotes / invoices" and keep the rest as advance.`);
    }
    return { fx: null, problem: null };
  }
  if (opts.relink) return refuse(`${id} is in ${cur} — a relink books in ₹ only. Reconcile this line by hand.`);
  const r = parseInwardRemittance(line.description);
  /* R-1678: paid in ₹, or a foreign quote with no invoice yet (reconcile_bank_credit_fx_invoice pays an
     INVOICE) — settled in full through the split with p_rest 'fx'; a ₹ credit more than 10% off is a
     plain ₹ payment (part / TDS / advance as usual). */
  if (!r || !item.invoice_id) {
    const sf = splitFxPlan([{ item, amount: item.amount_due }], line, { customerCountry: opts.customerCountry });
    return sf.problem ? refuse(sf.problem) : { fx: null, problem: null, splitFx: sf.fx };
  }
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

const curOf = (c: string | null | undefined) => (c ?? "").trim().toUpperCase() || "INR";

/**
 * R-1678 — foreign-currency items settled in full from one bank credit (reconcile_bank_credit_split,
 * p_rest 'fx'; migration 20261105175200 holds the same rules, in the same order).
 *   · every item in ONE foreign currency with a rate, each paid its whole ₹ due, no new sale;
 *   · an inward remittance on the line ("INW … USD1500.0@95"): same currency, amount × rate = the
 *     credit, bank rate within 25% of the invoices', never more dollars than due (an advance), dollars
 *     short ≤ 5% (Bank Charges) — else refused, as R-2427 refuses it;
 *   · a ₹ credit (NEFT, Razorpay…): within 10% of the ₹ due. Anything else is NOT an exchange
 *     difference — {fx: null, problem: null}: book it in ₹ as usual (part payment, TDS, advance);
 *   · forex = Σ ₹ due − charges − the credit in whole rupees, split by each item's foreign amount
 *     (the last item takes the rounding).
 * {fx: null, problem: null} also = no foreign item (a plain ₹ split).
 */
export function splitFxPlan(
  picks: ReadonlyArray<{ item: PlanItem; amount: number }>,
  line: { description: string | null | undefined; credit: number },
  opts: { sale?: boolean; customerCountry?: string | null } = {},
): { fx: SplitFx | null; problem: string | null } {
  const plain = { fx: null, problem: null };
  const foreign = picks.filter((p) => curOf(p.item.currency) !== "INR");
  if (foreign.length === 0) return plain;
  const r = parseInwardRemittance(line.description);
  /* A remittance in a foreign currency settles its invoices or is refused (R-2427); a ₹ credit that is
     not an exchange settlement is simply a ₹ payment. */
  const no = (problem: string) => (r ? { fx: null, problem } : plain);
  const idOf = (i: PlanItem) => i.invoice_id ?? i.quote_id ?? "An item";
  const cur = curOf(foreign[0].item.currency);
  const inr = picks.find((p) => curOf(p.item.currency) === "INR");
  if (inr) return no(`${idOf(foreign[0].item)} is in ${cur} and ${idOf(inr.item)} is in ₹ — pay them separately.`);
  const other = picks.find((p) => curOf(p.item.currency) !== cur);
  if (other) return no(`${idOf(other.item)} is in ${curOf(other.item.currency)} but ${idOf(foreign[0].item)} is in ${cur} — pay invoices of one currency together.`);
  if (opts.sale) return no(`An exchange gain / loss settles open invoices in ${cur} only — book the new sale on its own.`);
  const noRate = picks.find((p) => !(Number(p.item.fx_rate) > 0));
  if (noRate) return no(`${idOf(noRate.item)} is in ${cur} but has no exchange rate in the app. Reconcile this line by hand.`);
  const part = picks.find((p) => Math.round(p.amount) < p.item.amount_due);
  if (part) return no(`${idOf(part.item)} gets less than its ${rupee(part.item.amount_due)} due — an inward remittance in ${cur} settles its invoices in full. Reconcile a part payment in ${cur} by hand.`);
  const dues = picks.map((p) => Math.round(p.amount));
  const fdues = picks.map((p, k) => Math.round((dues[k] / Number(p.item.fx_rate)) * 100) / 100);
  const due = dues.reduce((a, b) => a + b, 0);
  const foreignDue = Math.round(fdues.reduce((a, b) => a + b, 0) * 100) / 100;
  const f = (n: number) => formatForeign(n, cur, Number.isInteger(n) ? 0 : 2);
  let bankCharges = 0;
  if (r) {
    if (r.currency !== cur) return no(`These invoices are in ${cur}, but this money came in ${r.currency}. Reconcile this line by hand.`);
    if (!remittanceFitsCredit(r, line.credit)) return no(`The bank line is ${rupee(line.credit)}, but ${formatRemittance(r)} is ${rupee(remittanceInr(r))}. Reconcile this line by hand.`);
    if (Math.abs(r.rate / (due / foreignDue) - 1) > FX_RATE_MAX_DRIFT) return no(`The bank's rate (₹${r.rate}) is more than 25% away from these invoices' — this money is probably for something else. Reconcile this line by hand.`);
    const raw = Math.round((foreignDue - r.amount) * 100) / 100;
    const short = Math.abs(raw) <= 0.02 * picks.length ? 0 : raw;
    if (short < 0) return no(`The bank got ${f(r.amount)} but only ${f(foreignDue)} is due — the extra is the customer's advance. Reconcile this line by hand.`);
    if (short > foreignDue * FX_CHARGES_MAX_SHARE) return no(`The bank got ${f(r.amount)} but ${f(foreignDue)} is due — ${f(short)} short is more than bank charges (5%). Reconcile a part payment in ${cur} by hand.`);
    bankCharges = Math.round(short * r.rate);
  } else if (!isExportSupply(opts.customerCountry) || line.credit > due || due - line.credit > due * FX_INR_GAP_SHARE) {
    /* R-1678b: a customer in India, more than due (an advance) or more than 5% short (TDS, a fee, a
       part payment) — not an exchange difference. */
    return plain;
  }
  const credit = Math.round(line.credit);
  const forex = due - bankCharges - credit;
  let leftShare = credit;
  let leftCharges = bankCharges;
  const parts = picks.map((p, k): SplitFxPart => {
    const last = k === picks.length - 1;
    const bankShare = last ? leftShare : Math.round((line.credit * fdues[k]) / foreignDue);
    const charges = last ? leftCharges : Math.round((bankCharges * fdues[k]) / foreignDue);
    leftShare -= bankShare;
    leftCharges -= charges;
    return { id: idOf(p.item), foreignDue: fdues[k], due: dues[k], bankShare, bankCharges: charges, forex: dues[k] - bankShare - charges };
  });
  const gapPct = r ? null : Math.round(((due - line.credit) / due) * 10000) / 100;
  return { fx: { currency: cur, foreignDue, due, remittance: r, gapPct, bankCharges, forex, parts }, problem: null };
}

/**
 * R-1678b: what the sheet pre-selects for a ₹ credit on foreign invoices. "rupee" (book it in ₹) when the
 * gap looks like TDS (1 / 2 / 5 / 10% of the taxable value — tdsRateFor, the rule the ₹ amount check
 * uses) or the line is a gateway settlement (Razorpay / PayU / Stripe / Cashfree: the gap is its fee);
 * else "fx". An inward remittance has no choice (its dollars settle the invoices).
 */
export function fxDefaultChoice(fx: SplitFx, line: { description: string | null | undefined; credit: number }, taxable: number): FxChoice {
  if (fx.remittance) return "fx";
  if (GATEWAY_RE.test(line.description ?? "")) return "rupee";
  if (tdsRateFor(line.credit, fx.due, taxable > 0 ? taxable : null) !== null) return "rupee";
  return "fx";
}

/** R-1678: one sentence for the sheet — what the exchange difference books. */
export function splitFxText(fx: SplitFx): string {
  const n = fx.parts.length;
  const what = n === 1 ? `${fx.parts[0].id} is settled in full` : `All ${n} invoices are settled in full`;
  const foreignDue = formatForeign(fx.foreignDue, fx.currency, Number.isInteger(fx.foreignDue) ? 0 : 2);
  const bits = [
    fx.bankCharges > 0 ? `${rupee(fx.bankCharges)} Bank Charges (remitting bank)` : null,
    fx.forex < 0 ? `${rupee(-fx.forex)} exchange gain to "${EXCHANGE_LEDGER}"` : fx.forex > 0 ? `${rupee(fx.forex)} exchange loss to "${EXCHANGE_LEDGER}"` : null,
  ].filter(Boolean);
  const split = n > 1 && fx.forex !== 0
    ? ` By each invoice's ${fx.currency}: ${fx.parts.map((p) => `${p.id} ${p.forex < 0 ? "gain" : "loss"} ${rupee(Math.abs(p.forex))}`).join(", ")}.`
    : "";
  const gap = fx.gapPct !== null && fx.gapPct !== 0 ? ` The ₹ gap is ${fx.gapPct}% of the due.` : "";
  return `${what} (${foreignDue} due = ${rupee(fx.due)} at ${n === 1 ? "its" : "their"} own rate)`
    + (bits.length ? ` — ${bits.join(" + ")} on the bank line's date. Nothing stays due; no TDS.` : ". Nothing stays due.")
    + split + gap;
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
