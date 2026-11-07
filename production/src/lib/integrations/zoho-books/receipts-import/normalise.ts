/**
 * R-2501 (G-FY2526) — one Zoho Books customer payment (R-2498 getFyDocDetail kind "customerpayments",
 * the raw v3 detail in `raw`) → the facts its FY 2025-26 receipt is booked from, money in WHOLE
 * RUPEES (CLAUDE.md §13). Paise → rupees happens HERE and only here, once per figure.
 *
 * Zoho's shape (India): `amount` = the money received; each `invoices[]` line has `amount_applied`
 * (money put on that invoice) and `tax_amount_withheld` (the TDS the customer kept back on it);
 * `unused_amount` = money not applied (the customer's excess → an advance here, as the app does).
 * What one invoice line settles = applied + TDS.
 *
 *   cash      = applied, in rupees    — the money on that invoice
 *   tds       = TDS, in rupees        — ONLY Zoho's own tax_amount_withheld; never worked out from a
 *                                       rate or a short payment (card: exact Zoho TDS only)
 *   settle    = cash + tds            — what it takes off the invoice
 *   excess    = round(amount) − Σ cash — must match Zoho's unused_amount (else refused)
 *   received  = amount in paise       — ONLY to find the bank line (credit to the paisa); never booked
 * Rounding (review): the lines' cash is rounded so it ADDS UP to round(Σ applied) (largest remainder),
 * the same for TDS — so Σ cash + excess = round(amount): the receipts equal the money received.
 *
 * R-2565 — Razorpay's fee. Razorpay keeps its fee + 18% GST on it before it settles, and Zoho records
 * that as the payment's `bank_charges`: `amount` stays the FULL money the customer paid (it is what is
 * applied to the invoices), only `amount − bank_charges` reached the clearing account. So:
 *   fee       = bank_charges, whole rupees rounded DOWN (see feeRupees), GST included (as payments.gateway_fee, R-045)
 *   feeGst    = the GST inside it = round(fee × 18 / 118) (Razorpay's GST on its fee is 18%; Zoho keeps
 *               no split) — input credit only when the Razorpay vendor carries a GSTIN (R-045 / R-2099)
 * The receipt stays the full amount on the invoice; the fee is booked as Razorpay's "Bank Charges"
 * expense (EXP-RZPFEE-<receipt>), and the bank line is the Razorpay SETTLEMENT (R-2099, which takes
 * this already-booked fee off its own). Only for a Razorpay payment (mode or deposit account says
 * Razorpay): any other bank charge is still booked by hand.
 *
 * `problems` are reasons the payment must NOT be booked, whatever the app holds (not INR, non-Razorpay
 * bank charges, the totals not adding up, TDS not split by invoice, …). Pure: no I/O.
 */
import type { ZohoFyDocDetail } from "../fy-fetch";
import { toPaise } from "../fy-fetch";
import { paiseToRupees } from "../sales-import/normalise";

export interface ReceiptLine {
  zohoInvoiceId: string;
  invoiceNumber: string;
  /** Money + TDS this payment settles on the invoice, whole rupees. */
  settle: number;
  /** Zoho's TDS on this invoice, whole rupees (0 = none). */
  tds: number;
}

export interface ZohoReceiptFacts {
  zohoId: string;
  number: string;
  date: string;
  /** Zoho customer payments carry no status of their own — '' (the scan keys on it). */
  status: string;
  zohoCustomerId: string;
  customerName: string;
  /** The app's method word (record_multi_invoice_payment's list). */
  method: "upi" | "razorpay" | "bank_transfer" | "cheque" | "cash" | "other";
  zohoMode: string;
  /** Zoho's reference number (usually the bank UTR), '' when none. */
  reference: string;
  /** The Zoho account it was deposited to (the screen maps it to an app bank / cash account). */
  depositAccountId: string;
  depositAccountName: string;
  /** Money received, whole rupees. */
  amount: number;
  /** The same in paise — only for finding the bank line. */
  receivedPaise: number;
  lines: ReceiptLine[];
  /** Money not applied to any invoice → advance, whole rupees. */
  excess: number;
  /** TDS in total, whole rupees. */
  tds: number;
  /** R-2565: Razorpay's fee Zoho took off as bank charges, whole rupees, GST included (0 = none). */
  fee: number;
  /** R-2565: the 18% GST inside `fee`, whole rupees. */
  feeGst: number;
  /** R-2565 (review): a Razorpay payment (mode or deposit account) — it reaches the bank inside a Razorpay
   *  settlement (R-2099), so it is never matched alone to a bank line, fee or no fee. */
  viaSettlement: boolean;
  problems: string[];
}

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());

/** R-2565: the problem the scan carried for EVERY bank-charge payment before Razorpay's fee could be
 *  booked — a payment read before R-2565 shows it until it is read from Zoho again. */
export const OLD_BANK_CHARGES_PROBLEM = "Zoho took bank charges off this payment — book it by hand.";

/** R-2565: the fee in whole rupees, ROUNDED DOWN (review): R-2099's settlement books only what is not yet
 *  booked and refuses when the booked fees exceed its own — rounding each payment up (₹10.50 → ₹11 twice
 *  against a ₹21 settlement fee) would block the settlement for good; the paise left over are booked by it. */
export const feeRupees = (feePaise: number): number => (feePaise > 0 ? Math.floor(feePaise / 100) : 0);

/** R-2565: GST inside a Razorpay fee (fee + 18% GST on it), whole rupees. */
export const feeGstOf = (fee: number): number => (fee > 0 ? Math.round((fee * 18) / 118) : 0);

/** R-2565: a Razorpay payment — Zoho's mode or the account it was deposited to says Razorpay. */
export const isRazorpayPayment = (mode: string, accountName: string): boolean => /razorpay/i.test(mode) || /razorpay/i.test(accountName);

/**
 * Paise amounts → whole rupees that ADD UP to the rounded total (largest remainder): rounding
 * each line alone could book ₹1,002 for ₹1,001 received (500.50 + 500.50).
 */
export function apportion(paise: readonly number[]): number[] {
  const total = paiseToRupees(paise.reduce((s, x) => s + x, 0));
  const floor = paise.map((p) => Math.floor(p / 100));
  let left = total - floor.reduce((s, x) => s + x, 0);
  const order = paise.map((p, k) => ({ k, rem: p - floor[k] * 100 })).sort((a, b) => b.rem - a.rem || a.k - b.k);
  const out = [...floor];
  for (const o of order) { if (left <= 0) break; out[o.k] += 1; left -= 1; }
  return out;
}

/** Zoho's payment mode → the app's method word. */
export function appMethod(mode: string): ZohoReceiptFacts["method"] {
  const m = mode.toLowerCase();
  if (m.includes("cash")) return "cash";
  if (m.includes("cheque") || m.includes("check")) return "cheque";
  if (m.includes("upi")) return "upi";
  if (m.includes("razorpay")) return "razorpay";
  if (/bank|neft|rtgs|imps|transfer|remittance|wire/.test(m)) return "bank_transfer";
  return "other";
}

export function zohoReceiptFacts(d: ZohoFyDocDetail): ZohoReceiptFacts {
  const r = d.raw;
  const problems: string[] = [];
  const rawLines = Array.isArray(r.invoices) ? (r.invoices as Array<Record<string, unknown>>) : [];
  const kept = rawLines
    .map((l) => ({ id: str(l.invoice_id), no: str(l.invoice_number), ap: toPaise(l.amount_applied), tp: toPaise(l.tax_amount_withheld) }))
    .filter((l) => l.ap !== 0 || l.tp !== 0);
  if (kept.some((l) => l.ap < 0 || l.tp < 0)) problems.push("A negative amount is applied to an invoice in Zoho — book it by hand.");
  const appliedPaise = kept.reduce((s, l) => s + l.ap, 0);
  const tdsPaise = kept.reduce((s, l) => s + l.tp, 0);
  const cash = apportion(kept.map((l) => l.ap));
  const tdsR = apportion(kept.map((l) => l.tp));
  const lines: ReceiptLine[] = kept.map((l, k) => ({ zohoInvoiceId: l.id, invoiceNumber: l.no, settle: cash[k] + tdsR[k], tds: tdsR[k] }));
  const amountPaise = toPaise(r.amount);
  const excessPaise = amountPaise - appliedPaise;
  const currency = str(r.currency_code).toUpperCase();

  if (currency && currency !== "INR") problems.push(`Received in ${currency} in Zoho — book a foreign-currency receipt by hand.`);
  if (amountPaise <= 0) problems.push("Zoho shows no money received on this payment.");
  /* R-2565: Razorpay's fee (bank_charges) is booked as its Bank Charges expense; any other bank charge by hand. */
  const feePaise = toPaise(r.bank_charges);
  const razorpay = isRazorpayPayment(str(r.payment_mode), str(r.account_name));
  if (feePaise < 0) problems.push("Zoho shows negative bank charges on this payment — book it by hand.");
  else if (feePaise > 0 && !razorpay) problems.push("Zoho took bank charges off this payment and it is not a Razorpay payment — book it by hand.");
  else if (feePaise > 0 && feePaise >= amountPaise) problems.push("Zoho's Razorpay fee is not less than the money received — book it by hand.");
  if (lines.some((l) => !l.zohoInvoiceId)) problems.push("An invoice line in Zoho has no invoice id.");
  if (new Set(lines.map((l) => l.zohoInvoiceId)).size !== lines.length) problems.push("Zoho applies this payment to one invoice twice.");
  if (excessPaise < 0) {
    problems.push("Zoho applies more to its invoices than the payment received — its amounts do not add up.");
  } else if (r.unused_amount !== undefined && Math.abs(toPaise(r.unused_amount) - excessPaise) > 0) {
    problems.push("Zoho's unused amount does not equal received − applied — its amounts do not add up.");
  }
  /* TDS at payment level that is not split by invoice: Zoho's own split is the only one booked. */
  const topTds = toPaise(r.tax_amount_withheld);
  if (topTds > 0 && topTds !== tdsPaise) problems.push("Zoho's TDS is not split by invoice — book the TDS by hand.");
  if (lines.some((l) => l.settle - l.tds < 0)) problems.push("An invoice line has more TDS than money settled.");

  return {
    zohoId: d.id,
    number: d.number,
    date: d.date,
    status: "",
    zohoCustomerId: d.contactId,
    customerName: d.contactName,
    method: feePaise > 0 && razorpay ? "razorpay" : appMethod(str(r.payment_mode)),
    zohoMode: str(r.payment_mode),
    reference: str(r.reference_number).slice(0, 100),
    depositAccountId: str(r.account_id),
    depositAccountName: str(r.account_name),
    amount: paiseToRupees(amountPaise),
    receivedPaise: amountPaise,
    lines,
    excess: Math.max(0, paiseToRupees(amountPaise) - cash.reduce((s, x) => s + x, 0)),
    tds: paiseToRupees(tdsPaise),
    fee: feeRupees(feePaise),
    feeGst: feeGstOf(feeRupees(feePaise)),
    viaSettlement: razorpay,
    problems: [...new Set(problems)],
  };
}
