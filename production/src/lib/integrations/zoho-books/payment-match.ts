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
  listCustomerPaymentsPage, listInvoiceCreditsApplied, listInvoicePayments, ZohoApiError,
} from "./api";
import { mapGstTreatment, monthsOf, parseLineDescription, subsPeriodMonths } from "./import-plan";
import { parsePlaceOfSupply, parseZohoDate } from "@/lib/import/zoho-opening-invoices";
import { stateCodeFromGstin } from "@/lib/gst/gstin-state";
import { normalizeCountry } from "@/lib/gst/countries";
import { GST_STATE_BY_CODE } from "@/lib/utils";
import type { CustomerGstTreatment } from "@/lib/gst/customer-gst-treatment";
import { parseInwardRemittance, type InwardRemittance } from "@/lib/banking/inward-remittance";
import { bankRefKey } from "@/lib/banking/narration-ref";

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
  /** R-2494: TDS this payment withheld on this invoice (the payment's invoices[].tax_amount_withheld). */
  tdsApplied?: number | null;
  total: number | null;
  lines: ZohoMatchLine[];
  /** R-2474: what Zoho's invoice says was paid / credited and when — the plan makes last year's
   *  opening invoice from it (balance as at the FY start). Absent = read before R-2474. */
  history?: ZohoInvoiceHistory | null;
}

/** R-2474: one Zoho invoice's money history (from the invoice detail the match already reads). */
export interface ZohoInvoiceHistory {
  dueDate: string | null;
  /** Zoho's currency code (null = none given). */
  currency: string | null;
  /** What Zoho says is still due today. */
  balance: number | null;
  writeOff: number;
  gstin: string | null;
  /** GST state code of the invoice's place of supply ("07"), null = none. */
  placeOfSupply: string | null;
  /** Receipts applied to the invoice: cash amount + TDS withheld, by date. */
  payments: Array<{ paymentId: string | null; date: string | null; amount: number; tds: number }>;
  /** Credit notes applied to the invoice, by date. */
  credits: Array<{ date: string | null; amount: number }>;
}

/** The Zoho customer of a match. R-2363: also WHERE it is, so "Create customer" makes it right
 *  (optional only so older hand-built matches in tests still type-check). */
export interface ZohoMatchCustomer {
  zohoId: string;
  name: string;
  gstin: string | null;
  /** "India", a foreign country's list name, or "" (Zoho says overseas but gives no country). */
  country?: string;
  /** Zoho's GST treatment in our words; null = Zoho gave none (the form picks from the facts). */
  gstTreatment?: CustomerGstTreatment | null;
  /** Indian GST state name, or the foreign state / province Zoho has; null = not known. */
  state?: string | null;
}

/**
 * R-2363 — where a Zoho customer is, from a Zoho contact (or invoice) record. Staging, 2 Nov: Ranz
 * International LLC (Zoho: gst_treatment "overseas", billing country U.A.E) was created from Find in
 * Zoho as India / unregistered. Overseas → the billing country ("" when Zoho has none — never India)
 * and its own state; otherwise India, the state from place of contact, else the GSTIN, else an
 * invoice's place of supply, else the billing state (the bulk "Reconcile from Zoho" — zohoContactInfo —
 * reads the same contact fields in the same order). Nothing known
 * → no state, never a guess.
 */
export function zohoCustomerPlace(
  raw: Record<string, unknown>, gstin: string | null,
): { country: string; gstTreatment: CustomerGstTreatment | null; state: string | null } {
  const code = str(raw.gst_treatment);
  const billing = (raw.billing_address && typeof raw.billing_address === "object") ? raw.billing_address as Record<string, unknown> : {};
  if ((code ?? "").toLowerCase() === "overseas") {
    return { country: normalizeCountry(str(billing.country) ?? str(raw.country) ?? ""), gstTreatment: "overseas", state: str(billing.state) };
  }
  /* An invoice's place_of_supply is where ONE sale went (a branch), so it comes after the GSTIN. */
  const stateCode = parsePlaceOfSupply(str(raw.place_of_contact)) ?? stateCodeFromGstin(gstin)
    ?? parsePlaceOfSupply(str(raw.place_of_supply)) ?? parsePlaceOfSupply(str(billing.state));
  return { country: "India", gstTreatment: mapGstTreatment(code), state: stateCode ? GST_STATE_BY_CODE[stateCode] ?? null : null };
}

export interface ZohoPaymentMatch {
  by: "utr" | "amount_date" | "picked";
  payment: ZohoPaymentRow;
  customer: ZohoMatchCustomer;
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
 * The UTR-looking tokens of a bank line, most likely first: the rail's own reference (R-2534,
 * narration-ref.ts), its Reference column, then narration
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
  /* R-2534: the reference the rail's own slot carries (UTR / RRN) comes first. */
  const parsed = bankRefKey(line.description, line.reference);
  if (parsed) push(parsed);
  if (line.reference) push(line.reference);
  const desc = (line.description ?? "").toUpperCase();
  for (const tok of desc.split(/[^A-Z0-9]+/)) {
    if (tok.length >= 12 && tok.length <= 22 && !desc.includes(`${tok}@`)) push(tok);   // a phone UPI id is not a UTR
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

/** R-2474: a Zoho invoice detail → its money history (payments, credits, write-off, balance). No
 *  extra Zoho call: readZohoPaymentMatch already reads each invoice's detail. */
export function zohoInvoiceHistory(inv: Record<string, unknown>): ZohoInvoiceHistory {
  const arr = (v: unknown) => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);
  const gstin = str(inv.gst_no);
  return {
    dueDate: parseZohoDate(str(inv.due_date)),
    currency: str(inv.currency_code)?.toUpperCase() ?? null,
    balance: num(inv.balance),
    writeOff: num(inv.write_off_amount) ?? 0,
    gstin: gstin ? gstin.toUpperCase() : null,
    placeOfSupply: parsePlaceOfSupply(str(inv.place_of_supply)),
    payments: arr(inv.payments).map(receiptFromZoho),
    credits: arr(inv.credits).map(creditFromZoho),
  };
}

type InvoiceReceipt = ZohoInvoiceHistory["payments"][number];

/** One receipt on an invoice — the invoice detail's payments[] or GET /invoices/{id}/payments. */
function receiptFromZoho(p: Record<string, unknown>): InvoiceReceipt {
  return { paymentId: str(p.payment_id), date: parseZohoDate(str(p.date)), amount: num(p.amount) ?? 0, tds: num(p.tax_amount_withheld) ?? 0 };
}

/** One applied credit note — the invoice detail's shape (credited_amount) or /creditsapplied's (amount_applied). */
function creditFromZoho(c: Record<string, unknown>): { date: string | null; amount: number } {
  return { date: parseZohoDate(str(c.credited_date) ?? str(c.date)), amount: num(c.credited_amount) ?? num(c.amount_applied) ?? num(c.amount) ?? 0 };
}

const near = (a: number, b: number) => Math.abs(a - b) <= 0.5;

/** A Zoho error on an extra history read that is not "busy" (429), "signed out" (401) or Zoho being
 *  down (5xx / network) → the history stays as the detail gave it; openingFromZoho then refuses an
 *  invoice that does not add up. Busy / signed out / down are thrown — the bulk route pauses on 429. */
async function orKeep<T>(read: () => Promise<T>, keep: T): Promise<T> {
  try {
    return await read();
  } catch (e) {
    const s = e instanceof ZohoApiError ? e.status : undefined;
    if (s !== undefined && s >= 400 && s < 500 && s !== 401 && s !== 429) return keep;
    throw e;
  }
}

/**
 * R-2494: the invoice's history with its dated receipts and credits. Zoho's GET /invoices/{id} (v3
 * reference) has only the totals payment_made / credits_applied — no lists (5 Nov staging: every
 * fully-paid invoice read "receipts and credits ₹0"). A list is judged by its SUM against Zoho's total
 * (an empty `payments: []` with payment_made > 0 is incomplete too):
 *   - payments: the list adds up to payment_made → used as it is. Otherwise payment_made is THIS
 *     payment's amount applied (± its TDS) → this payment is the one receipt (no extra call);
 *     otherwise (or no payment_made and no list) GET /invoices/{id}/payments.
 *   - credits: the list adds up to credits_applied (or none applied / no total) → as it is;
 *     otherwise GET /invoices/{id}/creditsapplied.
 * THIS payment's row always carries its amount applied to this invoice (a split payment's list row
 * may carry the whole payment). The two reads run together.
 */
async function completeInvoiceHistory(
  inv: Record<string, unknown>, applied: { id: string; amount: number | null; tds: number },
  payment: ZohoPaymentRow, deps: ZohoReadDeps,
): Promise<ZohoInvoiceHistory> {
  const f = deps.fetch ?? fetch;
  const h = zohoInvoiceHistory(inv);
  const cash = applied.amount ?? 0;
  const own = (p: InvoiceReceipt): InvoiceReceipt => (cash > 0 && p.paymentId === payment.zohoId ? { ...p, amount: cash, tds: applied.tds } : p);

  const made = num(inv.payment_made);
  const listedCash = h.payments.reduce((s, p) => s + p.amount, 0);
  const listedAll = listedCash + h.payments.reduce((s, p) => s + p.tds, 0);
  const paymentsOk = made === null ? Array.isArray(inv.payments) : made <= 0 || near(listedCash, made) || near(listedAll, made);
  const onlyThis = made !== null && cash > 0 && (near(made, cash) || near(made, cash + applied.tds));
  const payments: Promise<InvoiceReceipt[]> = paymentsOk ? Promise.resolve(h.payments)
    : onlyThis ? Promise.resolve([{ paymentId: payment.zohoId, date: parseZohoDate(payment.date), amount: cash, tds: applied.tds }])
      : orKeep(async () => (await listInvoicePayments(deps.orgId, deps.token, applied.id, f)).map(receiptFromZoho), h.payments);

  const credited = num(inv.credits_applied);
  const creditsOk = credited === null || credited <= 0 || near(h.credits.reduce((s, c) => s + c.amount, 0), credited);
  const credits = creditsOk ? Promise.resolve(h.credits)
    : orKeep(async () => (await listInvoiceCreditsApplied(deps.orgId, deps.token, applied.id, f)).map(creditFromZoho), h.credits);

  const [p, c] = await Promise.all([payments, credits]);
  return { ...h, payments: p.map(own), credits: c };
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
    .map((i) => ({ id: str(i.invoice_id), number: str(i.invoice_number) ?? "", amount: num(i.amount_applied), tds: num(i.tax_amount_withheld) ?? 0 }))
    .filter((i): i is { id: string; number: string; amount: number | null; tds: number } => !!i.id);

  const invoices: ZohoMatchInvoice[] = [];
  let gstin: string | null = null;
  /* R-2363: the record that says where the customer is — the invoice that gave the GSTIN, else the contact. */
  let placeFrom: Record<string, unknown> = {};
  for (const a of applied.slice(0, MAX_INVOICES)) {
    const inv = await getInvoiceDetail(deps.orgId, deps.token, a.id, f);
    if (!gstin && str(inv.gst_no)) placeFrom = inv;
    gstin = gstin ?? str(inv.gst_no);
    invoices.push({
      zohoId: a.id,
      number: str(inv.invoice_number) ?? a.number,
      date: parseZohoDate(str(inv.date)),
      amountApplied: a.amount,
      tdsApplied: a.tds,
      total: num(inv.total),
      lines: matchLinesFromInvoice({ ...inv, invoice_number: str(inv.invoice_number) ?? a.number }),
      history: await completeInvoiceHistory(inv, a, payment, deps),
    });
  }
  if (!gstin && payment.customerZohoId) {
    const contact = await getContact(deps.orgId, deps.token, payment.customerZohoId, f);
    gstin = str(contact.gst_no);
    placeFrom = contact;
  }
  const upperGstin = gstin ? gstin.toUpperCase() : null;
  const place = zohoCustomerPlace(placeFrom, upperGstin);
  return {
    by,
    payment,
    customer: {
      zohoId: payment.customerZohoId, name: payment.customerName,
      /* Kept even for an overseas customer: the app-customer match (mapZohoCustomer) uses it;
         the Add-customer seed drops it for overseas (newCustomerSeedFromZoho). */
      gstin: upperGstin,
      ...place,
    },
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
