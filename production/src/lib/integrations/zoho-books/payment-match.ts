/**
 * R-2359 — "Find in Zoho" for a money-in bank line. READ-ONLY to Zoho, server-side only.
 *
 * Pardeep (2 Nov, FY 2026-27 audit): 57 Zoho payments (₹25.1 L) are already in the app's bank but
 * not reconciled. Zoho's payment reference usually carries the bank UTR — e.g. the HDFC line
 * "NEFT CR-…-IDFB6202M2890149" is Zoho payment ref IDFB6202M2890149 → invoice INV/26-27/0613.
 *
 *   1. UTR: every UTR-looking token of the line (its Reference, then the narration) is looked up
 *      with Zoho's `reference_number_contains`; a row counts only when its reference really
 *      contains the UTR (leading zeros ignored on both sides).
 *   2. Fallback: payments dated within ±3 days of the line whose amount is within ±₹2.
 *   3. Several candidates → the owner picks one (nothing is guessed); none → "no match".
 *   4. The match: the payment, its Zoho customer (name + GSTIN), the invoice numbers it was
 *      applied to and each invoice's line items (name, sku, qty, rate, period dates when Zoho has them).
 *
 * Nothing is written anywhere — the Reconcile sheet only pre-fills its existing sale form from this.
 */
import {
  CF_SERVICE_EXPIRY, CF_SUBS_PERIOD, getContact, getCustomerPayment, getInvoiceDetail, invoiceFieldValue,
  listCustomerPaymentsPage,
} from "./api";
import { monthsOf, parseLineDescription, subsPeriodMonths } from "./import-plan";
import { parseZohoDate } from "@/lib/import/zoho-opening-invoices";
import { parseInwardRemittance, type InwardRemittance } from "@/lib/banking/inward-remittance";

/** ₹ either side of the bank amount the fallback accepts (bank charges / round-off). */
export const AMOUNT_TOLERANCE = 2;
/** Days either side of the bank date the fallback searches. */
export const DATE_WINDOW_DAYS = 3;
/** Invoices read for one payment (a payment applied to more is rare; the rest are listed by number). */
export const MAX_INVOICES = 5;

export interface BankCreditLine {
  txnDate: string;
  credit: number;
  description: string | null;
  reference: string | null;
}

export interface ZohoPaymentRow {
  zohoId: string;
  number: string;
  date: string | null;
  amount: number;
  reference: string;
  customerZohoId: string;
  customerName: string;
  /** R-2402: TDS the customer withheld on this payment (Zoho tax_amount_withheld); 0 / absent = none. */
  taxWithheld?: number;
  /** R-2425: Zoho's currency_code ("USD", "INR"; the amount is in it); absent = Zoho gave none. */
  currency?: string;
  /** R-2425: Zoho's exchange_rate (INR per unit) for a foreign payment. */
  exchangeRate?: number;
}

export interface ZohoMatchLine {
  invoiceNumber: string;
  name: string;
  sku: string | null;
  qty: number;
  /** ₹ per unit before tax, as Zoho billed it. */
  rate: number | null;
  /** Line total before tax. */
  itemTotal: number | null;
  /** Period from the line description ("Subscription Period: 1 Year/s (01/04/2026 - 31/03/2027)")
   *  or, failing that, invoice date → the invoice's Service Expiry. */
  start: string | null;
  end: string | null;
  /** Months the period covers; null = unknown; 0 = one-time (Subs Period says One-Time). */
  months: number | null;
  domain: string | null;
}

export interface ZohoMatchInvoice {
  zohoId: string;
  number: string;
  date: string | null;
  amountApplied: number | null;
  total: number | null;
  lines: ZohoMatchLine[];
}

export interface ZohoPaymentMatch {
  by: "utr" | "amount_date" | "picked";
  payment: ZohoPaymentRow;
  customer: { zohoId: string; name: string; gstin: string | null };
  invoices: ZohoMatchInvoice[];
  /** Invoice numbers the payment was applied to beyond MAX_INVOICES (not read). */
  moreInvoices: string[];
}

export type FindZohoResult =
  | { kind: "match"; match: ZohoPaymentMatch }
  | { kind: "several"; by: "utr" | "amount_date"; candidates: ZohoPaymentRow[] }
  | { kind: "none"; utrs: string[]; from: string; to: string };

type Fetch = typeof fetch;

const str = (v: unknown): string | null => {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s ? s : null;
};
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Upper-case letters and digits only, leading zeros dropped: "0000162440272175" → "162440272175". */
export function normRef(s: string | null | undefined): string {
  return (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^0+/, "");
}

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/**
 * The UTR-looking tokens of a bank line, most likely first: its Reference column, then narration
 * tokens of 12–22 letters/digits with at least 8 digits (UPI/IMPS 12, NEFT 16, RTGS 22). IFSC
 * codes and 10-digit phone numbers are not UTRs.
 */
export function utrCandidates(line: Pick<BankCreditLine, "description" | "reference">): string[] {
  const out: string[] = [];
  const push = (raw: string) => {
    const t = normRef(raw);
    if (t.length < 10 || t.length > 22) return;
    if ((t.match(/\d/g) ?? []).length < 8) return;
    if (IFSC_RE.test(raw.toUpperCase())) return;
    if (!out.includes(t)) out.push(t);
  };
  if (line.reference) push(line.reference);
  for (const tok of (line.description ?? "").split(/[^A-Za-z0-9]+/)) {
    if (tok.length >= 12 && tok.length <= 22) push(tok);
  }
  return out.slice(0, 4);
}

/** Does Zoho's payment reference carry this UTR? */
export function referenceHasUtr(reference: string | null | undefined, utr: string): boolean {
  const r = normRef(reference);
  const u = normRef(utr);
  return u.length >= 10 && r.includes(u);
}

export function paymentFromZoho(row: Record<string, unknown>): ZohoPaymentRow | null {
  const id = str(row.payment_id);
  if (!id) return null;
  return {
    zohoId: id,
    number: str(row.payment_number) ?? "",
    date: str(row.date),
    amount: num(row.amount) ?? 0,
    reference: str(row.reference_number) ?? "",
    customerZohoId: str(row.customer_id) ?? "",
    customerName: str(row.customer_name) ?? "",
    ...(num(row.tax_amount_withheld) ? { taxWithheld: num(row.tax_amount_withheld)! } : {}),
    ...foreignOf(row),
  };
}

/** R-2425: the Zoho payment's currency (INR kept as "INR" — an overseas customer may be billed in
 *  ₹) and, for a foreign one, its rate; {} when Zoho gives none. */
function foreignOf(row: Record<string, unknown>): { currency?: string; exchangeRate?: number } {
  const cur = (str(row.currency_code) ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) return {};
  if (cur === "INR") return { currency: "INR" };
  const rate = num(row.exchange_rate);
  return { currency: cur, ...(rate && rate > 0 ? { exchangeRate: rate } : {}) };
}

/**
 * R-2425: is this Zoho payment the bank line's money? A ₹ payment: its amount within ±₹2 of the
 * credit. A foreign one: only on an inward remittance in that currency ("INW … USD1024.0@93.6"),
 * its amount within 2 units of the narration's foreign amount — never the rupee credit. Zoho gave
 * no currency: either fits. `rem` = the line's remittance, parsed once by the caller.
 */
export function isLineMoney(
  p: Pick<ZohoPaymentRow, "amount" | "currency">, line: Pick<BankCreditLine, "credit" | "description">,
  rem: InwardRemittance | null = parseInwardRemittance(line.description),
): boolean {
  const inr = amountClose(p.amount, line.credit);
  if (p.currency === "INR") return inr;
  if (p.currency) return !!rem && p.currency === rem.currency && amountClose(p.amount, rem.amount);
  return inr || (!!rem && amountClose(p.amount, rem.amount));
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const dayGap = (a: string | null, b: string) =>
  a ? Math.abs(Date.parse(`${a.slice(0, 10)}T00:00:00Z`) - Date.parse(`${b.slice(0, 10)}T00:00:00Z`)) / 86_400_000 : Infinity;

export const amountClose = (a: number, b: number) => Math.abs(a - b) <= AMOUNT_TOLERANCE + 1e-9;

export interface ZohoReadDeps { orgId: string; token: string; fetch?: Fetch }

/** Step 1 + 2: which Zoho payment is this bank line? */
export async function findZohoPayment(line: BankCreditLine, deps: ZohoReadDeps): Promise<
  { kind: "one"; by: "utr" | "amount_date"; payment: ZohoPaymentRow }
  | { kind: "several"; by: "utr" | "amount_date"; candidates: ZohoPaymentRow[] }
  | { kind: "none"; utrs: string[]; from: string; to: string }
> {
  const f = deps.fetch ?? fetch;
  const utrs = utrCandidates(line);
  const rem = parseInwardRemittance(line.description);
  for (const utr of utrs) {
    const page = await listCustomerPaymentsPage(deps.orgId, deps.token, { referenceContains: utr }, f);
    const hits = page.rows.map(paymentFromZoho).filter((p): p is ZohoPaymentRow => !!p && referenceHasUtr(p.reference, utr));
    if (hits.length === 0) continue;
    if (hits.length === 1) return { kind: "one", by: "utr", payment: hits[0] };
    const sameAmount = hits.filter((p) => isLineMoney(p, line, rem));
    if (sameAmount.length === 1) return { kind: "one", by: "utr", payment: sameAmount[0] };
    return { kind: "several", by: "utr", candidates: (sameAmount.length ? sameAmount : hits).slice(0, 10) };
  }
  const from = addDays(line.txnDate, -DATE_WINDOW_DAYS);
  const to = addDays(line.txnDate, DATE_WINDOW_DAYS);
  const page = await listCustomerPaymentsPage(deps.orgId, deps.token, { dateStart: from, dateEnd: to }, f);
  const near = page.rows.map(paymentFromZoho)
    .filter((p): p is ZohoPaymentRow => !!p && isLineMoney(p, line, rem))
    .sort((a, b) => dayGap(a.date, line.txnDate) - dayGap(b.date, line.txnDate));
  if (near.length === 1) return { kind: "one", by: "amount_date", payment: near[0] };
  if (near.length > 1) return { kind: "several", by: "amount_date", candidates: near.slice(0, 10) };
  return { kind: "none", utrs, from, to };
}

/** One invoice's lines with their periods. */
export function matchLinesFromInvoice(inv: Record<string, unknown>): ZohoMatchLine[] {
  const number = str(inv.invoice_number) ?? "";
  const invDate = parseZohoDate(str(inv.date));
  const subs = subsPeriodMonths(invoiceFieldValue(inv, CF_SUBS_PERIOD));
  const expiry = parseZohoDate(invoiceFieldValue(inv, CF_SERVICE_EXPIRY));
  const items = Array.isArray(inv.line_items) ? (inv.line_items as Array<Record<string, unknown>>) : [];
  return items.map((li) => {
    const { domain, period } = parseLineDescription(str(li.description));
    const start = period?.start ?? (expiry && invDate && expiry > invDate ? invDate : null);
    const end = period?.end ?? (start ? expiry : null);
    const months = period ? monthsOf(period) : subs === "one_time" ? 0 : typeof subs === "number" ? subs : null;
    return {
      invoiceNumber: number,
      name: str(li.name) ?? str(li.item_name) ?? "",
      sku: str(li.sku),
      qty: num(li.quantity) ?? 0,
      rate: num(li.rate),
      itemTotal: num(li.item_total),
      start,
      end,
      months,
      domain,
    };
  });
}

/** Step 4: the payment's customer, invoices and lines. */
export async function readZohoPaymentMatch(
  paymentId: string, by: ZohoPaymentMatch["by"], deps: ZohoReadDeps,
): Promise<ZohoPaymentMatch> {
  const f = deps.fetch ?? fetch;
  const raw = await getCustomerPayment(deps.orgId, deps.token, paymentId, f);
  const payment = paymentFromZoho({ ...raw, payment_id: raw.payment_id ?? paymentId }) as ZohoPaymentRow;
  const applied = (Array.isArray(raw.invoices) ? (raw.invoices as Array<Record<string, unknown>>) : [])
    .map((i) => ({ id: str(i.invoice_id), number: str(i.invoice_number) ?? "", amount: num(i.amount_applied) }))
    .filter((i): i is { id: string; number: string; amount: number | null } => !!i.id);

  const invoices: ZohoMatchInvoice[] = [];
  let gstin: string | null = null;
  for (const a of applied.slice(0, MAX_INVOICES)) {
    const inv = await getInvoiceDetail(deps.orgId, deps.token, a.id, f);
    gstin = gstin ?? str(inv.gst_no);
    invoices.push({
      zohoId: a.id,
      number: str(inv.invoice_number) ?? a.number,
      date: parseZohoDate(str(inv.date)),
      amountApplied: a.amount,
      total: num(inv.total),
      lines: matchLinesFromInvoice({ ...inv, invoice_number: str(inv.invoice_number) ?? a.number }),
    });
  }
  if (!gstin && payment.customerZohoId) {
    const contact = await getContact(deps.orgId, deps.token, payment.customerZohoId, f);
    gstin = str(contact.gst_no);
  }
  return {
    by,
    payment,
    customer: { zohoId: payment.customerZohoId, name: payment.customerName, gstin: gstin ? gstin.toUpperCase() : null },
    invoices,
    moreInvoices: applied.slice(MAX_INVOICES).map((a) => a.number),
  };
}

/** The whole lookup: a chosen payment (`paymentId`, after "several") or a search from the line. */
export async function findInZoho(line: BankCreditLine, deps: ZohoReadDeps, paymentId?: string | null): Promise<FindZohoResult> {
  if (paymentId) return { kind: "match", match: await readZohoPaymentMatch(paymentId, "picked", deps) };
  const found = await findZohoPayment(line, deps);
  if (found.kind === "none") return found;
  if (found.kind === "several") return found;
  return { kind: "match", match: await readZohoPaymentMatch(found.payment.zohoId, found.by, deps) };
}
