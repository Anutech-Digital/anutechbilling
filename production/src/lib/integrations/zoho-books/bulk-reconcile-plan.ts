/**
 * R-2402 — "Reconcile from Zoho" (bulk): the PLAN for each open money-in bank line. Pure, no I/O.
 *
 * Pardeep (3 Nov, HDFC 4523): ~199 open money-in lines; one-by-one Reconcile →
 * Find in Zoho → check the subscription → fix dates → Save is 5–8 min a line. Doing 7 by hand
 * found the traps this plan avoids (Anutech-HQ/drafts/RECON-4523/progress-2026-11-03.md):
 *
 *   1. A new sale made a NEW subscription even when the customer already had one for that domain
 *      → a line whose customer + domain has a live subscription books NO subscription; the seat
 *      difference Zoho vs app is listed for a person.
 *   2. A pro-rata add-on line (Zoho billed less than a full term, ending on an existing
 *      subscription's renewal) became its own subscription at the pro-rata price → it books no
 *      subscription and reads "add N seats to <subscription>".
 *   3. Several lines with different periods got ONE renewal date (the latest) → each new
 *      subscription keeps its own start and renewal from its Zoho line (dateFixes after booking).
 *   4. A new customer from Zoho needed "Paid on the customer's behalf" when the payer name differed
 *      → when Zoho matched the payment by the bank UTR, the payer is recorded as paying on the
 *      customer's behalf; matched only by amount + date, the row waits for a person.
 *   5. Zoho's contact email / phone were not carried → a new customer gets them when Zoho has them.
 *
 * A row with a problem (no state, amounts differ by more than ₹1, payer differs without a UTR match,
 * mixed terms, …) is UNTICKED by default and says why. Booking goes through the Reconcile sheet's
 * own path (reconcile_bank_credit_new_sale) — no new money RPC.
 *
 * R-2419 (3 Nov, first real run on staging, 4523: 40 ticked, six kinds of wrong entries) — before a
 * row is ticked:
 *   (a) a Zoho invoice of an EARLIER financial year (INV/25-26/…, or dated before the books' start)
 *       is last year's revenue → it settles the customer's OPENING receivable (the opening invoice
 *       imported from Zoho: record_multi_invoice_payment → reconcile_bank_txn), never a new sale;
 *       no opening invoice in the app → unticked with the reason.
 *   (b) one new subscription per customer + domain + product in a run — the newest line makes it,
 *       older lines are charges on it (planAll).
 *   (c) a subscription whose Zoho term has already ended is never created — a past-period charge.
 *   (d) TDS only when the withheld amount is 1 / 2 / 10 % of the taxable value (±₹2); else
 *       unticked "Short by ₹X".
 *   (e) an open quote / invoice of the customer for the same money (±₹2) → the plan PAYS it
 *       (reconcile_bank_credit_to_item); priced below cost and not approved → "approve it first".
 *   (f) possible doubles are unticked with the reason: the same amount received from the customer
 *       within 35 days; a subscription billed in parts already billed for that period; a
 *       subscription the app already has paid past the Zoho period.
 */
import {
  salePreview, type SaleCycle, type SaleLine,
} from "@/lib/banking/credit-pay-for";
import {
  payerFromNarration, payerMatchesCustomer, type KnownPayer, type NarrationPayer, type PayerRelation,
} from "@/lib/banking/customer-payer";
import { tdsSectionGuess } from "@/lib/banking/tds-section";
import { stateCodeFromGstin } from "@/lib/gst/gstin-state";
import { GST_STATE_BY_CODE, formatDate, rupee } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";
import { isSplitBilled } from "@/lib/billing/instalments";
import type { BillingCycle } from "@/lib/supabase/database.types";
import { parsePlaceOfSupply } from "@/lib/import/zoho-opening-invoices";
import {
  exportLutProblem, exportLutRows, formatRemittance, parseInwardRemittance, remittanceFitsCredit, type ExportLut, type InwardRemittance,
} from "@/lib/banking/inward-remittance";
import { lutFor } from "@/lib/gst/export-lut";
import { formatForeign } from "@/lib/currency";
import type { FindZohoResult, ZohoMatchInvoice, ZohoMatchLine, ZohoPaymentMatch } from "./payment-match";
import { mapZohoCustomer, normCompanyName, zohoSaleLine, zohoSaleNumber } from "./payment-prefill";

/** Lines the bulk-match route plans per request (each costs about 2–4 Zoho calls). */
export const BULK_PAGE = 8;
/** ₹ the sale total may differ from the money (bank credit + TDS) and still be booked as it is. */
export const AMOUNT_SLACK = 1;
/** Days a pro-rata line's end may sit from an existing subscription's renewal and still be its add-on. */
export const ADD_ON_DAY_SLACK = 3;
/** R-2419: ₹ an open quote's due, a TDS amount or an earlier receipt may differ and still be "the same". */
export const MATCH_SLACK = 2;
/** R-2419 (f): days around a line in which the same amount from the same customer reads as a double. */
export const DOUBLE_DAYS = 35;

// ── Inputs ────────────────────────────────────────────────────────────────────────────────

export interface BulkLine {
  id: string;
  txnDate: string;
  credit: number;
  description: string | null;
  reference: string | null;
}

/** One line of the bulk-match route's answer. R-2419: `facts` = what the app already has for the
 *  app customer Zoho's customer maps to (null: a customer new from Zoho); `booksStart` = the day
 *  after the company's opening balances (null: none set). Absent = read before R-2419. */
export interface BulkMatchRow {
  line: BulkLine;
  result: FindZohoResult;
  contact: ZohoContactInfo | null;
  facts?: CustomerFacts | null;
  booksStart?: string | null;
}

/** R-2419 (e): one open quote / unpaid invoice of the customer (bank_credit_open_items). */
export interface OpenItemFact {
  kind: string;
  quoteId: string | null;
  invoiceId: string | null;
  docDate: string | null;
  /** Whole rupees still owed (the database's figure). */
  due: number;
  taxable: number;
  makesSubscription: boolean;
  /** The quote is priced below cost and not approved — the refusal text; null = can be paid. */
  approvalBlock: string | null;
  /** R-2427: the invoice's currency when it is not INR (its ₹ due is at fxRate); null/absent = ₹. */
  currency?: string | null;
  /** R-2427: the rate the invoice was issued at (₹ per unit). */
  fxRate?: number | null;
}

/** R-2419 (a): an opening invoice imported from Zoho that still has money due. */
export interface OpeningFact { id: string; number: string | null; date: string | null; due: number }

/** R-2419 (f): a receipt already booked for the customer. */
export interface ReceiptFact { id: string; date: string; amount: number; reference: string | null }

/** R-2419 (f): a billed period of one of the customer's subscriptions. */
export interface BilledFact { subId: string; start: string; end: string; invoiceId: string }

export interface CustomerFacts {
  customerId: string;
  openItems: OpenItemFact[];
  openings: OpeningFact[];
  receipts: ReceiptFact[];
  billed: BilledFact[];
}

/** What Zoho says about the customer (its contact), for a customer the app does not have yet. */
export interface ZohoContactInfo {
  zohoId: string;
  name: string;
  gstin: string | null;
  /** GST state code ("07"), from Zoho's place of contact, else the GSTIN. */
  stateCode: string | null;
  country: string;
  email: string | null;
  phone: string | null;
  personName: string | null;
  gstTreatment: string | null;
  customerType: "business" | "individual";
}

export interface PlanCustomerRow {
  id: string;
  name: string;
  gstin?: string | null;
  state_code?: string | null;
  country?: string | null;
  domain?: string | null;
}

export interface PlanSubRow {
  id: string;
  customer_id: string | null;
  plan: string;
  domain: string | null;
  seats: number;
  status: string;
  start_date: string | null;
  renewal_date: string | null;
  /** R-2419 (f): how it is billed (monthly / quarterly … = billed in parts). Absent = unknown. */
  billing_cycle?: BillingCycle | null;
  billed_externally_until?: string | null;
  /** Made by a sale in the app (its quote) — an imported subscription has none. */
  quote_id?: string | null;
  external_source?: string | null;
}

type CatalogArg = Parameters<typeof zohoSaleLine>[1];

export interface PlanContext {
  customers: readonly PlanCustomerRow[];
  subscriptions: readonly PlanSubRow[];
  catalog: CatalogArg;
  payers: readonly KnownPayer[];
  ownNames: readonly string[];
  /** The company issues bills of supply (no GST) — every sale is at 0%. */
  noGst?: boolean;
  /** R-2419 (c): today (IST, YYYY-MM-DD). Absent = today in IST. */
  today?: string;
  /** R-2440: the company's LUT (Settings → Company). An export receipt is booked at 0% only under an
   *  LUT for its financial year; absent = not loaded (the server still refuses without one). R-2444:
   *  the per-FY list (tenant_luts); the old single-LUT shape is still read. */
  lut?: ExportLut;
}

// ── Output ────────────────────────────────────────────────────────────────────────────────

/** R-2419: past_charge — (c) its term already ended; charge_on_new — (b) an older line of a
 *  customer + domain + product whose NEWEST line in this run makes the subscription. Neither
 *  makes a subscription. */
export type LineAction = "new_sub" | "existing_sub" | "add_seats" | "one_time" | "past_charge" | "charge_on_new";

export interface PlanLine {
  name: string;
  qty: number;
  rate: number;
  cycle: SaleCycle;
  domain: string | null;
  start: string | null;
  /** The day after the Zoho period ends — the subscription's renewal date. */
  renewal: string | null;
  months: number | null;
  invoiceNumber: string;
  action: LineAction;
  /** The existing subscription this line belongs to (existing_sub / add_seats). */
  sub: { id: string; plan: string; seats: number; renewal_date: string | null; domain: string | null } | null;
  /** One plain sentence for the table, e.g. "Add 3 seats to Business Starter (zuna.one)". */
  text: string;
}

export interface SeatDiff { subId: string; plan: string; domain: string | null; appSeats: number; zohoSeats: number }

export type PlanCustomer =
  | { kind: "existing"; id: string; name: string; by: "gstin" | "name" }
  | {
      kind: "new"; zohoId: string; name: string; gstin: string | null; stateCode: string | null; state: string | null;
      country: string; email: string | null; phone: string | null; contactName: string | null;
      gstTreatment: string | null; customerType: "business" | "individual";
    };

export interface PlanPayer {
  name: string;
  payer: NarrationPayer;
  /** What is recorded on the line before the sale (set_bank_line_payer); null = nothing. */
  record: { relation: PayerRelation; note: string | null } | null;
  differs: boolean;
}

/** A dated subscription the RPC made with the sale's one start/renewal — corrected after booking. */
export interface DateFix { name: string; qty: number; domain: string | null; start: string; renewal: string }

/** R-2419: what "Book selected" does with the row. */
export type BookKind = "new_sale" | "pay_item" | "opening";

/** (e) pay this open quote / invoice — reconcile_bank_credit_to_item. */
export interface PayItemSpec {
  quoteId: string | null;
  invoiceId: string | null;
  due: number;
  createSubscription: boolean | null;
  subStart: string | null;
  /** R-2427: an export receipt paying an invoice in its currency — reconcile_bank_credit_fx_invoice
   *  (the ₹ due as the receipt, the gap → Bank Charges / Foreign Exchange Gain / Loss). */
  fx?: FxInvoicePay | null;
}

/** R-2427: what reconcile_bank_credit_fx_invoice is sent, and what it will book (the plan's own sums). */
export interface FxInvoicePay {
  currency: string;
  /** The bank's rate and foreign amount — the narration's. */
  rate: number;
  foreignAmount: number;
  invoiceRate: number;
  foreignDue: number;
  bankCharges: number;
  /** ₹; < 0 = an exchange gain. */
  forex: number;
}

/** (a) settle this opening invoice — record_multi_invoice_payment, then reconcile_bank_txn. */
export interface OpeningSpec {
  /** The one opening invoice already in the app; null = R-2474 parts (made from Zoho / several). */
  invoiceId: string | null;
  number: string | null;
  /** The bank money (whole rupees) — the receipt. */
  received: number;
  reference: string;
  /** R-2474: each of last year's invoices this line settles — one receipt across them. Absent =
   *  planned before R-2474 (the single invoiceId above). */
  parts?: OpeningPart[];
}

/** R-2474: one of last year's invoices the bank line settles. */
export interface OpeningPart {
  /** The opening invoice in the app; null = made from Zoho (create) in the Book step first. */
  invoiceId: string | null;
  number: string;
  /** Cash applied to it (whole rupees). */
  amount: number;
  tds: number;
  create: OpeningCreate | null;
}

/** R-2474: an opening invoice made from Zoho's own invoice — import_opening_invoices' row (R-1739:
 *  no GST, no revenue — they were filed from Zoho). Keyed by the Zoho number: a re-run skips it. */
export interface OpeningCreate {
  zohoId: string;
  number: string;
  invoiceDate: string;
  dueDate: string | null;
  total: number;
  /** Due as at the FY start (books' start): total − Zoho receipts / TDS / credits dated before it. */
  balance: number;
  gstin: string | null;
  posStateCode: string | null;
}

const fmtDay = (iso: string) => formatDate(iso);
const whole = (n: number) => Math.abs(n - Math.round(n)) < 0.005;

/**
 * R-2474: Zoho's invoice as it stood on `cutoff` (the books' start / 1 Apr) → the opening invoice to
 * make. Refused (with the reason) when Zoho's own history does not add up to its balance today, when
 * a write-off / paise / a foreign currency is involved, or when nothing was due on the cutoff.
 */
export function openingFromZoho(
  inv: ZohoMatchInvoice, cutoff: string,
): { ok: true; create: OpeningCreate } | { ok: false; problem: string } {
  const h = inv.history;
  const no = inv.number;
  if (!h) return { ok: false, problem: `Zoho's invoice ${no} was not read with its payments — press Start again.` };
  if (h.currency && h.currency !== "INR") return { ok: false, problem: `Zoho's invoice ${no} is in ${h.currency} — only a rupee invoice becomes an opening invoice. Reconcile this line by hand.` };
  const total = inv.total;
  if (total === null || !(total > 0) || !inv.date) return { ok: false, problem: `Zoho's invoice ${no} has no total or date. Reconcile this line by hand.` };
  if (h.writeOff > 0) return { ok: false, problem: `Zoho's invoice ${no} has ${rupees(h.writeOff)} written off — Zoho does not say when, so its 1 Apr balance is not certain. Reconcile this line by hand.` };
  const paidAll = h.payments.reduce((s, p) => s + p.amount + p.tds, 0) + h.credits.reduce((s, c) => s + c.amount, 0);
  if (h.balance === null || Math.abs(total - paidAll - h.balance) > 0.5) {
    return { ok: false, problem: `Zoho's invoice ${no} does not add up: total ${rupees(total)}, receipts and credits ${rupees(paidAll)}, balance ${rupees(h.balance ?? 0)}. Check it in Zoho, or reconcile this line by hand.` };
  }
  if ([...h.payments, ...h.credits].some((x) => !x.date)) return { ok: false, problem: `A receipt on Zoho's invoice ${no} has no date. Reconcile this line by hand.` };
  const before = h.payments.filter((p) => p.date! < cutoff).reduce((s, p) => s + p.amount + p.tds, 0)
    + h.credits.filter((c) => c.date! < cutoff).reduce((s, c) => s + c.amount, 0);
  const balance = total - before;
  if (!whole(total) || !whole(balance)) return { ok: false, problem: `Zoho's invoice ${no} has paise (total ${total}, due on ${fmtDay(cutoff)} ${Math.round(balance * 100) / 100}) — an opening invoice is in whole rupees. Reconcile this line by hand.` };
  if (Math.round(balance) <= 0) return { ok: false, problem: `Zoho's invoice ${no} was paid before ${fmtDay(cutoff)} — nothing was due on ${fmtDay(cutoff)}, so this line is not for its opening balance. Reconcile this line by hand.` };
  return {
    ok: true,
    create: {
      zohoId: inv.zohoId, number: no, invoiceDate: inv.date.slice(0, 10), dueDate: h.dueDate,
      total: Math.round(total), balance: Math.round(balance), gstin: h.gstin, posStateCode: h.placeOfSupply,
    },
  };
}

export interface BookSpec {
  kind: BookKind;
  item: PayItemSpec | null;
  opening: OpeningSpec | null;
  lines: SaleLine[];
  createSubscription: boolean;
  subStart: string | null;
  subRenewal: string | null;
  billingCycle: "monthly" | null;
  externalNumber: string | null;
  tdsAmount: number;
  tdsRatePct: number | null;
  tdsSection: string | null;
  dateFixes: DateFix[];
  /** R-2425: an export receipt — the sale is in this currency at the bank's rate (₹ = the bank
   *  credit; reconcile_bank_credit_new_sale_fx). Null = an INR sale. */
  fx: SaleFx | null;
}

/** R-2425: the foreign side of an export sale booked from an inward remittance. R-2427: billed =
 *  Zoho's amount when the remitting bank kept charges (more than foreignAmount, ≤ 5%). */
export interface SaleFx { currency: string; rate: number; foreignAmount: number; billed?: number | null }

/** R-2427: the most a remittance may be short and still read as the remitting bank's charges. */
export const FX_CHARGES_MAX_SHARE = 0.05;
/** R-2427: the bank's rate may differ from the invoice's by this share before it reads as a wrong match. */
export const FX_RATE_MAX_DRIFT = 0.25;

/**
 * R-2427: an export receipt settling a foreign invoice in full — the same sums as
 * reconcile_bank_credit_fx_invoice (migration 20261104001617): the receipt is the ₹ due; the short
 * part × the bank's rate is Bank Charges; due − charges − credit is the exchange difference
 * (< 0 = gain). problem = why it cannot be booked this way; null = it can.
 */
export function fxInvoiceSettlement(
  due: number, invoiceRate: number, remittance: InwardRemittance, credit: number,
): { foreignDue: number; short: number; bankCharges: number; forex: number; problem: string | null } {
  const foreignDue = Math.round((due / invoiceRate) * 100) / 100;
  const raw = Math.round((foreignDue - remittance.amount) * 100) / 100;
  /* The ₹ due is whole rupees: a cent or two of difference is rounding, never "charges kept abroad". */
  const short = Math.abs(raw) <= 0.02 ? 0 : raw;
  const bankCharges = Math.max(0, Math.round(Math.max(short, 0) * remittance.rate));
  const forex = Math.round(due - bankCharges - credit);
  const f = (n: number) => formatForeign(n, remittance.currency, Number.isInteger(n) ? 0 : 2);
  let problem: string | null = null;
  if (short < -0.01) problem = `The bank got ${f(remittance.amount)} but the invoice has only ${f(foreignDue)} due — reconcile this line by hand (the extra is an advance).`;
  else if (short > foreignDue * FX_CHARGES_MAX_SHARE) problem = `The bank got ${f(remittance.amount)} but the invoice has ${f(foreignDue)} due — ${f(short)} short is more than bank charges (5%). Record it as a part payment in the line's Reconcile.`;
  else if (Math.abs(remittance.rate / invoiceRate - 1) > FX_RATE_MAX_DRIFT) problem = `The bank's rate (₹${remittance.rate}) is more than 25% away from the invoice's (₹${invoiceRate}) — this money is probably for something else. Reconcile this line by hand.`;
  return { foreignDue, short, bankCharges, forex, problem };
}

export interface PlanRow {
  txnId: string;
  txnDate: string;
  credit: number;
  description: string | null;
  kind: "match" | "several";
  /** R-2419: one sentence for a row that pays an open quote / settles an opening balance. */
  summary: string | null;
  zoho: {
    paymentId: string | null;
    paymentNumber: string | null;
    by: ZohoPaymentMatch["by"] | null;
    amount: number | null;
    /** R-2425: the Zoho payment's currency when it is not INR (amount is in it); null = INR. */
    currency?: string | null;
    invoiceNumbers: string[];
    candidates: number;
  };
  /** R-2425: the bank line's foreign inward remittance ("USD1024.0@93.6"); null = none. */
  remittance?: InwardRemittance | null;
  customer: PlanCustomer | null;
  lines: PlanLine[];
  seatDiffs: SeatDiff[];
  saleTotal: number | null;
  tds: number;
  payer: PlanPayer | null;
  /** Why the row is not ticked — empty = ready to book. */
  problems: string[];
  /** Things a person should look at after booking (still booked). */
  notes: string[];
  ticked: boolean;
  book: BookSpec | null;
}

// ── Small helpers ─────────────────────────────────────────────────────────────────────────

const str = (v: unknown): string | null => {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s ? s : null;
};
const day = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
export function nextDay(iso: string): string {
  const d = new Date(day(iso));
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const rupees = (n: number) => rupee(Math.round(n));
const normDom = (d: string | null | undefined) => (d ?? "").trim().toLowerCase() || null;
const normProduct = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const LIVE = new Set(["active", "paused"]);
const isIndia = (c: string | null | undefined) => ["", "in", "ind", "india", "bharat"].includes((c ?? "").trim().toLowerCase());

/** Zoho contact (detail) → what a new app customer is made with. Email / phone: the contact's own,
 *  else its primary contact person's. State: place of contact, else the GSTIN. */
export function zohoContactInfo(raw: Record<string, unknown>, fallback: { zohoId: string; name: string; gstin: string | null }): ZohoContactInfo {
  const persons = Array.isArray(raw.contact_persons) ? (raw.contact_persons as Array<Record<string, unknown>>) : [];
  const primary = persons.find((p) => p.is_primary_contact === true) ?? persons[0] ?? null;
  const gstin = (str(raw.gst_no) ?? fallback.gstin)?.toUpperCase() ?? null;
  const treatment = str(raw.gst_treatment);
  const billing = (raw.billing_address && typeof raw.billing_address === "object") ? raw.billing_address as Record<string, unknown> : {};
  const overseas = treatment === "overseas";
  const country = overseas ? (str(billing.country) ?? str(raw.country) ?? "") : "India";
  const person = [str(primary?.first_name), str(primary?.last_name)].filter(Boolean).join(" ").trim()
    || [str(raw.first_name), str(raw.last_name)].filter(Boolean).join(" ").trim();
  return {
    zohoId: str(raw.contact_id) ?? fallback.zohoId,
    name: str(raw.contact_name) ?? str(raw.company_name) ?? fallback.name,
    gstin,
    stateCode: overseas ? null : (parsePlaceOfSupply(str(raw.place_of_contact)) ?? stateCodeFromGstin(gstin) ?? parsePlaceOfSupply(str(billing.state))),
    country,
    email: str(raw.email) ?? str(primary?.email),
    phone: str(raw.mobile) ?? str(raw.phone) ?? str(primary?.mobile) ?? str(primary?.phone),
    personName: person || null,
    gstTreatment: treatment,
    customerType: str(raw.customer_sub_type) === "individual" ? "individual" : "business",
  };
}

/** TDS rate % that explains the withheld amount (1 / 2 / 10 when within 0.05), else 2 decimals. */
export function tdsRate(tds: number, taxable: number): number | null {
  if (!(tds > 0) || !(taxable > 0)) return null;
  const r = (tds / taxable) * 100;
  for (const k of [1, 2, 10]) if (Math.abs(r - k) <= 0.05) return k;
  return Math.round(r * 100) / 100;
}

/** The live subscription a Zoho line belongs to: same customer and end-domain; the same product
 *  wins when the domain has several. Null = no live subscription for that customer + domain. */
export function liveSubFor(
  line: { name: string; domain: string | null },
  customer: { id: string; domain?: string | null },
  subs: readonly PlanSubRow[],
): PlanSubRow | null {
  const key = normDom(line.domain) ?? normDom(customer.domain);
  const mine = subs.filter((s) => s.customer_id === customer.id && LIVE.has(s.status));
  const sameDomain = mine.filter((s) => (normDom(s.domain) ?? normDom(customer.domain)) === key);
  if (sameDomain.length === 0) return null;
  if (key === null) {
    /* No domain on either side: only the same product counts as "this subscription". */
    return sameDomain.find((s) => normProduct(s.plan) === normProduct(line.name)) ?? null;
  }
  return sameDomain.find((s) => normProduct(s.plan) === normProduct(line.name)) ?? sameDomain[0];
}

/** Zoho billed this annual line for less than a full year (pro-rata). */
function partTerm(zl: ZohoMatchLine, cycle: SaleCycle): boolean {
  return cycle === "annual_yearly" && zl.months !== null && zl.months > 0 && zl.months < 12;
}

const near = (a: string | null, b: string | null, days: number) =>
  !!a && !!b && Math.abs(day(a) - day(b)) / 86_400_000 <= days;

/** The pick-one row ("several Zoho payments could be this line"). */
export function severalRow(line: BulkLine, candidates: number): PlanRow {
  return {
    txnId: line.id, txnDate: line.txnDate, credit: line.credit, description: line.description, kind: "several", summary: null,
    zoho: { paymentId: null, paymentNumber: null, by: null, amount: null, invoiceNumbers: [], candidates },
    remittance: parseInwardRemittance(line.description),
    customer: null, lines: [], seatDiffs: [], saleTotal: null, tds: 0, payer: null,
    problems: [`Zoho has ${candidates} payments that could be this line — open the line's Reconcile and use Find in Zoho to pick one.`],
    notes: [], ticked: false, book: null,
  };
}

// ── R-2419 helpers ───────────────────────────────────────────────────────────────────────

const daysApart = (a: string, b: string) => Math.abs(day(a) - day(b)) / 86_400_000;
function prevDay(iso: string): string {
  const d = new Date(day(iso));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
const normNo = (s: string | null | undefined) => (s ?? "").trim().toUpperCase().replace(/\s+/g, "");

/** The financial year (the calendar year of its April) a date falls in. */
export function fyOf(iso: string): number {
  const y = Number(iso.slice(0, 4));
  return Number(iso.slice(5, 7)) >= 4 ? y : y - 1;
}

/** The financial year printed in an invoice number ("INV/25-26/0412" → 2025); null = none. */
export function fyInNumber(no: string): number | null {
  const m = /(?:^|[^0-9])(\d{2})-(\d{2})(?:[^0-9]|$)/.exec(no);
  if (!m) return null;
  const a = Number(m[1]);
  return (a + 1) % 100 === Number(m[2]) ? 2000 + a : null;
}

/** (a) A Zoho invoice of an earlier financial year than the bank line, or dated before the books'
 *  start — last year's revenue, so its money settles the opening receivable. */
export function isLastYearInvoice(inv: { number: string; date: string | null }, lineDate: string, booksStart: string | null): boolean {
  if (booksStart && inv.date && inv.date.slice(0, 10) < booksStart) return true;
  const fy = fyInNumber(inv.number) ?? (inv.date ? fyOf(inv.date) : null);
  return fy !== null && fy < fyOf(lineDate);
}

/** (d) The TDS % (1 / 2 / 10) the withheld amount is of the taxable value, within ₹2; null = none. */
export function tdsPctWithin(tds: number, taxable: number): 1 | 2 | 10 | null {
  if (!(tds > 0) || !(taxable > 0)) return null;
  for (const k of [1, 2, 10] as const) if (Math.abs(tds - (taxable * k) / 100) <= MATCH_SLACK) return k;
  return null;
}

/** (f) The day an existing subscription is paid till, when that is past the Zoho period — null when
 *  it is not, or when the app cannot tell (billed in parts: see the billed periods instead). */
export function paidPast(sub: PlanSubRow, period: { start: string | null; end: string | null }): string | null {
  if (!period.end) return null;
  if (sub.billed_externally_until && sub.billed_externally_until >= period.end) return sub.billed_externally_until;
  if (!sub.billing_cycle || isSplitBilled(sub.billing_cycle)) return null;
  if (!sub.renewal_date || sub.renewal_date <= period.end) return null;
  if (sub.start_date && period.start && sub.start_date > period.start) return null;
  return prevDay(sub.renewal_date);
}

const shortByText = (tds: number, taxable: number) =>
  `Short by ${rupees(tds)}: Zoho records it as TDS, but it is not 1%, 2% or 10% of the taxable ${rupees(taxable)}. Check the payment in Zoho, or reconcile this line by hand.`;

/** Options of one row's plan. */
export interface PlanOptions {
  /** What the app already has for the customer (route); undefined = not read. */
  facts?: CustomerFacts | null;
  booksStart?: string | null;
  /** planAll: an app customer's row must carry facts, else it is not ticked. */
  requireFacts?: boolean;
  /** (b) line index → the newest line of the same customer + domain + product in this run. */
  chargeOnNew?: ReadonlyMap<number, { label: string; date: string }>;
}

// ── The plan for one line ────────────────────────────────────────────────────────────────

export function planRow(
  line: BulkLine,
  match: ZohoPaymentMatch,
  contact: ZohoContactInfo | null,
  ctx: PlanContext,
  opts: PlanOptions = {},
): PlanRow {
  /* R-2419: problems by kind — which ones count depends on what the row books (new sale / pay an
     open item / settle an opening balance). */
  const custProblems: string[] = [];
  const zohoProblems: string[] = [];
  const saleProblems: string[] = [];
  const doubleProblems: string[] = [];
  const payerProblems: string[] = [];
  const notes: string[] = [];
  const today = ctx.today ?? istToday();
  const facts = opts.facts;

  /* 1. Customer — the app's (GSTIN, then name) or a new one from Zoho. */
  const mapped = mapZohoCustomer(match.customer, ctx.customers);
  const appCust = mapped ? ctx.customers.find((c) => c.id === mapped.id) ?? null : null;
  let customer: PlanCustomer;
  if (mapped && appCust) {
    customer = { kind: "existing", id: mapped.id, name: mapped.name, by: mapped.by };
    if (isIndia(appCust.country) && !(appCust.state_code ?? "").trim()) {
      custProblems.push(`No state: ${appCust.name} has no state in the app, so its GST invoice cannot be raised. Add the state in Customers, then run this again.`);
    }
  } else {
    const c = contact ?? {
      zohoId: match.customer.zohoId, name: match.customer.name, gstin: match.customer.gstin,
      stateCode: stateCodeFromGstin(match.customer.gstin), country: "India", email: null, phone: null,
      personName: null, gstTreatment: null, customerType: "business" as const,
    };
    const foreign = !isIndia(c.country);
    customer = {
      kind: "new", zohoId: c.zohoId, name: c.name.trim(), gstin: foreign ? null : c.gstin,
      stateCode: foreign ? null : c.stateCode, state: !foreign && c.stateCode ? GST_STATE_BY_CODE[c.stateCode] ?? null : null,
      country: c.country || "India", email: c.email, phone: c.phone,
      contactName: c.personName, gstTreatment: c.gstTreatment, customerType: c.customerType,
    };
    if (!foreign && !c.stateCode) {
      custProblems.push(`No state: Zoho has no state or GSTIN for ${c.name}. Add the place of contact in Zoho, or reconcile this line by hand.`);
    }
    if (c.country === "") {
      custProblems.push(`No country: Zoho marks ${c.name} as overseas but has no country. Reconcile this line by hand.`);
    }
    if (!c.email && !c.phone) notes.push(`${c.name}: Zoho has no email or phone — the customer is created without one; add it later.`);
  }

  /* 1b. R-2425: an export receipt — the bank narration carries the foreign amount and the bank's
     rate ("INW … USD1024.0@93.6"); Zoho's payment and invoice lines are in that currency. The sale
     is booked in it, each Zoho rate × the bank's rate, so the ₹ total is the bank credit. A
     customer billed in ₹ in Zoho (currency INR, or no currency and the ₹ amount = the credit) who
     pays by remittance stays an ordinary ₹ sale. */
  const remittance = parseInwardRemittance(line.description);
  const zohoCode = match.payment.currency ?? null;
  const payCur = zohoCode && zohoCode !== "INR" ? zohoCode : null;
  const zohoCur = payCur ?? (zohoCode || !remittance || Math.abs(match.payment.amount - line.credit) <= AMOUNT_SLACK ? null : remittance.currency);
  const fxProblems: string[] = [];
  let fx: SaleFx | null = null;
  if (remittance && zohoCur) {
    const z = (n: number) => formatForeign(n, zohoCur, Number.isInteger(n) ? 0 : 2);
    if (zohoCur !== remittance.currency) {
      fxProblems.push(`Currency differs: the bank received ${formatRemittance(remittance)}, the Zoho payment is ${z(match.payment.amount)}. Reconcile this line by hand.`);
    } else if (!remittanceFitsCredit(remittance, line.credit)) {
      fxProblems.push(`The bank narration says ${formatRemittance(remittance)}, which is not the ${rupee(line.credit)} credited. Reconcile this line by hand.`);
    } else if (match.payment.amount > remittance.amount + 0.005 && match.payment.amount - remittance.amount <= match.payment.amount * FX_CHARGES_MAX_SHARE) {
      /* R-2427 (2): the remitting bank kept its charges abroad — the bill is settled in full, the
         short part × the bank's rate is Bank Charges (not TDS). */
      const gap = Math.round((match.payment.amount - remittance.amount) * 100) / 100;
      fx = { currency: remittance.currency, rate: remittance.rate, foreignAmount: remittance.amount, billed: match.payment.amount };
      notes.push(`Short by ${z(gap)}: Zoho's payment is ${z(match.payment.amount)}, the bank received ${z(remittance.amount)} — the remitting bank kept it as charges: ${rupees(Math.round(gap * remittance.rate))} is booked as Bank Charges and the bill is settled in full.`);
    } else if (Math.abs(match.payment.amount - remittance.amount) > 0.005) {
      const gap = Math.round(Math.abs(match.payment.amount - remittance.amount) * 100) / 100;
      fxProblems.push(match.payment.amount > remittance.amount
        ? `Short by ${z(gap)}: Zoho's payment is ${z(match.payment.amount)}, the bank received ${z(remittance.amount)} — more than bank charges (5%), so this is a part payment. Reconcile this line by hand.`
        : `Amount differs: Zoho's payment is ${z(match.payment.amount)}, the bank received ${z(remittance.amount)}. Reconcile this line by hand.`);
    } else {
      fx = { currency: remittance.currency, rate: remittance.rate, foreignAmount: remittance.amount };
    }
  }
  /* Zoho's foreign rates in ₹ at the bank's rate (paise kept; the sale rounds its total once). */
  const lineFx = remittance && zohoCur === remittance.currency ? remittance.rate : null;
  if (!remittance && payCur) {
    fxProblems.push(`The Zoho payment is in ${payCur} (${formatForeign(match.payment.amount, payCur)}), but the bank line has no foreign amount and rate in its narration. Reconcile this line by hand.`);
  }

  /* 2. Lines and what each does to subscriptions. */
  const custForSubs = customer.kind === "existing" ? { id: customer.id, domain: appCust?.domain ?? null } : null;
  const lines: PlanLine[] = [];
  const saleLines: SaleLine[] = [];
  const seatDiffs: SeatDiff[] = [];
  const unmatched: string[] = [];
  for (const inv of match.invoices) {
    for (const zl of inv.lines) {
      const z = zohoSaleLine(zl, ctx.catalog);
      if (!z) continue;
      const made = lineFx ? { ...z, line: { ...z.line, rate: Math.round(z.line.rate * lineFx * 100) / 100 } } : z;
      const idx = lines.length;
      if (!made.inCatalog) unmatched.push(zl.name.trim());
      if (!(made.line.rate > 0)) saleProblems.push(`${zl.name.trim()}: Zoho gives no price for this line.`);
      const renewal = zl.start && zl.end && zl.end >= zl.start ? nextDay(zl.end) : null;
      const base = {
        name: made.line.name, qty: made.line.qty, rate: made.line.rate, cycle: made.cycle,
        domain: made.cycle === "one_time" ? null : normDom(zl.domain), start: zl.start, renewal,
        months: zl.months, invoiceNumber: inv.number,
      };
      let pl: PlanLine;
      const sub = made.cycle !== "one_time" && custForSubs ? liveSubFor(zl, custForSubs, ctx.subscriptions) : null;
      const subLite = sub ? { id: sub.id, plan: sub.plan, seats: sub.seats, renewal_date: sub.renewal_date, domain: sub.domain } : null;
      const where = (d: string | null) => (d ? ` (${d})` : "");
      const demote = opts.chargeOnNew?.get(idx) ?? null;
      if (made.cycle === "one_time") {
        pl = { ...base, action: "one_time", sub: null, text: "One-time — no subscription" };
      } else if (sub && partTerm(zl, made.cycle) && (near(renewal, sub.renewal_date, ADD_ON_DAY_SLACK) || near(zl.end, sub.renewal_date, ADD_ON_DAY_SLACK))) {
        pl = { ...base, action: "add_seats", sub: subLite, text: `Add ${zl.qty} seat${zl.qty === 1 ? "" : "s"} to ${sub.plan}${where(sub.domain ?? base.domain)} — no new subscription` };
      } else if (sub) {
        pl = { ...base, action: "existing_sub", sub: subLite, text: `Has ${sub.plan}${where(sub.domain ?? base.domain)} — no new subscription` };
        if (sub.seats !== zl.qty) {
          seatDiffs.push({ subId: sub.id, plan: sub.plan, domain: sub.domain ?? base.domain, appSeats: sub.seats, zohoSeats: zl.qty });
        }
        /* (f) the app already has this period: billed in parts → a bill for it; else paid past it. */
        const label = `${sub.plan}${where(sub.domain ?? base.domain)}`;
        const billed = facts && zl.start && zl.end
          ? facts.billed.find((b) => b.subId === sub.id && b.start <= zl.end! && b.end >= zl.start!) ?? null
          : null;
        const till = paidPast(sub, zl);
        if (billed) {
          doubleProblems.push(`Already billed: ${label} has invoice ${billed.invoiceId} for ${formatDate(billed.start)} – ${formatDate(billed.end)}, the same period as this Zoho bill.`);
        } else if (till && !sub.quote_id && sub.external_source) {
          notes.push(`${label} was imported (paid till ${formatDate(till)} in the app, with no sale here) — this payment is booked as a charge on it; check its dates.`);
        } else if (till) {
          doubleProblems.push(`Already paid: ${label} is paid till ${formatDate(till)} in the app, and this Zoho bill is for ${formatDate(zl.start)} – ${formatDate(zl.end)} — it looks booked already.`);
        }
      } else if (zl.end && zl.end < today) {
        /* (c) never a subscription whose term has already ended. */
        pl = { ...base, action: "past_charge", sub: null, text: `Term ended ${formatDate(zl.end)} — booked as a past-period charge, no subscription` };
        notes.push(`${made.line.name}${where(base.domain)}: Zoho's term ended ${formatDate(zl.end)} — no subscription made. If the customer still uses it, renew it from Subscriptions.`);
      } else if (demote) {
        /* (b) the newest line of this customer + domain + product in the run makes the subscription. */
        pl = { ...base, action: "charge_on_new", sub: null, text: `Charge only — the newest line for ${demote.label} (${formatDate(demote.date)}) makes the subscription` };
      } else {
        pl = { ...base, action: "new_sub", sub: null, text: base.start && renewal ? `New subscription — renews ${renewal}` : "New subscription" };
        if (partTerm(zl, made.cycle)) notes.push(`${made.line.name}: Zoho billed ${zl.months} month${zl.months === 1 ? "" : "s"} — check the yearly price on the new subscription before it renews.`);
      }
      lines.push(pl);
      saleLines.push(made.line);
    }
  }
  if (lines.length === 0) saleProblems.push("The Zoho invoice has no product lines to book.");
  if (match.moreInvoices.length) zohoProblems.push(`The Zoho payment covers more invoices (${match.moreInvoices.join(", ")}) than are read here. Reconcile this line by hand.`);
  if (unmatched.length) notes.push(`Not in the catalogue, booked with Zoho's name and price: ${[...new Set(unmatched)].join(", ")}.`);

  /* 2b. A pro-rata add-on whose main line is a NEW subscription in this same bill (no sub yet). */
  for (const pl of lines) {
    if (pl.action !== "new_sub" || pl.months === null || pl.months >= 12 || pl.cycle !== "annual_yearly") continue;
    const main = lines.find((o) => o !== pl && o.action === "new_sub" && (o.months ?? 0) >= 12
      && o.domain === pl.domain && near(o.renewal, pl.renewal, ADD_ON_DAY_SLACK));
    if (main) {
      pl.action = "add_seats";
      pl.text = `Add ${pl.qty} seat${pl.qty === 1 ? "" : "s"} to the new ${main.name} subscription — no subscription of its own`;
      const old = notes.findIndex((n) => n.startsWith(`${pl.name}: Zoho billed`));
      if (old >= 0) notes.splice(old, 1);
      notes.push(`After booking: set the new ${main.name}${pl.domain ? ` (${pl.domain})` : ""} subscription to ${main.qty + pl.qty} seats (${main.qty} + ${pl.qty} added).`);
    }
  }

  /* 3. One sale: which lines make subscriptions. */
  const monthly = lines.some((l) => l.cycle === "monthly");
  const annual = lines.some((l) => l.cycle === "annual_yearly");
  if (monthly && annual) saleProblems.push("The Zoho bill mixes monthly and yearly lines — one sale is one billing term. Reconcile this line by hand.");
  const newSub = lines.filter((l) => l.action === "new_sub");
  const kept = lines.filter((l) => l.action === "existing_sub" || l.action === "add_seats");
  let createSubscription = newSub.length > 0;
  /* (b)/(c) a past-period or older line is a plain charge on this sale — never a subscription. */
  let bookLines = saleLines.map((sl, i) => (lines[i].action === "past_charge" || lines[i].action === "charge_on_new")
    ? { ...sl, cycle: "one_time" as const, typedFor: "one_time" as const, domain: null }
    : sl);
  if (newSub.length > 0 && kept.length > 0) {
    /* Mixed: the lines of existing subscriptions are booked as one-time charges on this sale, so
       the RPC makes subscriptions ONLY for the new ones (the same as unticking "Create subscription"
       for those lines in the sheet). */
    if (newSub.some((l) => l.cycle === "monthly")) {
      saleProblems.push("A new monthly subscription and lines of existing subscriptions are on one bill — reconcile this line by hand.");
    }
    bookLines = bookLines.map((sl, i) => (lines[i].action === "existing_sub" || lines[i].action === "add_seats")
      ? { ...sl, cycle: "one_time" as const, typedFor: "one_time" as const, domain: null }
      : sl);
    notes.push(`${kept.map((l) => l.name).join(", ")}: booked as a charge on the existing subscription — no new subscription.`);
  }
  if (newSub.length === 0) createSubscription = false;

  /* Per-line dates: the sale carries the first new line's dates; the others are corrected after. */
  const dated = newSub.filter((l) => l.start && l.renewal && l.renewal > l.start);
  const first = dated[0] ?? null;
  const dateFixes: DateFix[] = dated.slice(1)
    .filter((l) => l.start !== first!.start || l.renewal !== first!.renewal)
    .map((l) => ({ name: l.name, qty: l.qty, domain: l.domain, start: l.start!, renewal: l.renewal! }));

  /* 4. Money: Zoho payment vs bank line; sale total vs bank + TDS; (d) TDS only at 1 / 2 / 10 %. */
  const foreign = customer.kind === "new" ? !isIndia(customer.country) : !isIndia(appCust?.country);
  const gstRate = ctx.noGst || foreign ? 0 : 18;
  const preview = salePreview(bookLines, gstRate);
  const tds = Math.max(0, Math.round(match.payment.taxWithheld ?? 0));
  const money = line.credit + tds;
  const foreignMoney = Boolean(zohoCur || (!remittance && payCur));
  if (foreignMoney) {
    /* R-2425: compared in the foreign currency above (fxProblems); the sale in ₹ against the credit. */
    zohoProblems.push(...fxProblems);
    /* R-2427: with charges kept abroad the sale is the BILLED amount at the bank's rate (the bank line + charges). */
    const expected = fx?.billed ? Math.round(fx.billed * fx.rate) : money;
    if (lines.length && lineFx && Math.abs(preview.total - expected) > AMOUNT_SLACK) {
      saleProblems.push(`Amount differs: the Zoho bill at the bank's rate comes to ${rupees(preview.total)}, ${fx?.billed ? `Zoho's ${formatForeign(fx.billed, fx.currency)} at the bank's rate is` : "the bank line is"} ${rupees(expected)}.`);
    }
    if (fx && !foreign) {
      custProblems.push(`${customer.name} is in India in the app, but this money came from abroad in ${fx.currency}. Set the customer's country (export), or reconcile this line by hand.`);
    }
    if (fx && tds > 0) {
      zohoProblems.push(`Zoho records TDS on a payment in ${fx.currency} — a foreign customer does not deduct Indian TDS. Check the payment in Zoho, or reconcile this line by hand.`);
    }
    if (fx && lines.some((l) => l.action === "new_sub")) notes.push(`The new subscription renews from the app in ₹ — before its renewal, set the renewal quote to ${fx.currency} (Quotes → Bill in currency).`);
    /* R-2440 (tax memo §1): 0% export only under an LUT for this line's FY — else unticked with the step. */
    const lutProblem = fx && ctx.lut !== undefined ? exportLutProblem(ctx.lut, line.txnDate) : null;
    if (lutProblem) saleProblems.push(lutProblem);
    /* R-2444: the ARN of THIS line's FY (an FY 2025-26 receipt names the FY 2025-26 LUT). */
    const lutNo = lutProblem ? null : lutFor(exportLutRows(ctx.lut), line.txnDate)?.arn.trim();
    if (fx) notes.push(`Export receipt ${formatRemittance(remittance!)}: booked in ${fx.currency} at the bank's rate, ₹ = the bank credit; 0% GST (export of services, zero-rated under ${lutNo ? `LUT ${lutNo}` : "LUT — check your LUT in Settings"}).`);
  } else if (Math.abs(match.payment.amount - line.credit) > AMOUNT_SLACK) {
    zohoProblems.push(`Amount differs: Zoho payment ${rupees(match.payment.amount)}, bank line ${rupees(line.credit)}.`);
  } else if (lines.length && Math.abs(preview.total - money) > AMOUNT_SLACK) {
    saleProblems.push(`Amount differs: the sale comes to ${rupees(preview.total)}, the bank line${tds ? ` + TDS ${rupees(tds)}` : ""} is ${rupees(money)}.`);
  }
  /* R-2444: a ₹ sale to a foreign customer is a 0% export too — the server refuses it without the LUT
     of the line's FY (trg_invoices_zz_export_lut), so the plan leaves it unticked with the step. */
  if (!fx && foreign && !ctx.noGst && lines.length && ctx.lut !== undefined) {
    const inrLutProblem = exportLutProblem(ctx.lut, line.txnDate);
    if (inrLutProblem) saleProblems.push(inrLutProblem);
  }
  if (tds > 0 && lines.length && tdsPctWithin(tds, preview.taxable) === null) saleProblems.push(shortByText(tds, preview.taxable));
  const rate = tdsRate(tds, preview.taxable);
  const custGstin = customer.kind === "new" ? customer.gstin : appCust?.gstin ?? null;
  const section = tds > 0 ? tdsSectionGuess(rate, custGstin).section : null;
  if (tds > 0) notes.push(`TDS ${rupees(tds)} (${rate ?? "?"}%) recorded under ${section} — check the customer's Form 16A.`);

  /* 5. Who paid. */
  const narr = payerFromNarration(line.description, ctx.ownNames);
  let payer: PlanPayer | null = null;
  if (narr) {
    const known = customer.kind === "existing" ? ctx.payers.filter((k) => k.customer_id === (customer as { id: string }).id) : [];
    const hit = known.find((k) => k.payer_name_key === narr.key) ?? null;
    const differs = !payerMatchesCustomer(narr, customer.name, known);
    if (differs && match.by !== "utr") {
      payerProblems.push(`Payer differs: the bank says ${narr.name}, Zoho's customer is ${customer.name}, and Zoho matched by amount and date, not the UTR. Check it in the line's Reconcile.`);
      payer = { name: narr.name, payer: narr, record: null, differs };
    } else if (differs) {
      payer = { name: narr.name, payer: narr, differs, record: { relation: "third_party", note: `Zoho payment ${match.payment.number || match.payment.zohoId} carries this bank UTR` } };
    } else {
      payer = { name: narr.name, payer: narr, differs, record: hit ? { relation: hit.relation, note: null } : null };
    }
  }

  /* 6. R-2419: what the row books — settle an opening balance (a), pay an open item (e), or a new
     sale (with the double checks of f). A row that must not be booked as a sale has no book. */
  const invoiceNumbers = [...match.invoices.map((i) => i.number), ...match.moreInvoices];
  let kind = "new_sale" as BookKind;
  let summary: string | null = null;
  let item: PayItemSpec | null = null;
  let opening: OpeningSpec | null = null;
  const pathProblems: string[] = [];
  let noBook = false;
  let fxPaid = false as boolean;
  const isExisting = customer.kind === "existing";
  const firstZoho = match.invoices.flatMap((i) => i.lines).find((l) => l.start || l.end) ?? null;

  const payItem = (it: OpenItemFact) => {
    kind = "pay_item";
    const ref = it.invoiceId ?? it.quoteId ?? "";
    summary = `Pays open ${it.invoiceId ? "invoice" : "quote"} ${ref} (${rupees(it.due)} due) — no new sale`;
    if (it.approvalBlock) {
      pathProblems.push(`Approve ${it.quoteId ?? ref} first: ${it.approvalBlock} Then run this again.`);
      noBook = true;
    }
    if (tds > 0 && tdsPctWithin(tds, it.taxable) === null) pathProblems.push(shortByText(tds, it.taxable));
    const ended = !!firstZoho?.end && firstZoho.end < today;
    const makeSub = it.makesSubscription ? !ended : null;
    if (it.makesSubscription && ended) notes.push(`Zoho's term ended ${formatDate(firstZoho!.end)} — the quote is paid without making a subscription.`);
    /* R-2427 (1)/(2): an export receipt paying an invoice in its own currency — settled in full; the
       short part → Bank Charges, the rest of the ₹ gap → Foreign Exchange Gain / Loss. */
    let fxPay: FxInvoicePay | null = null;
    if (fx && remittance && it.invoiceId && it.currency === fx.currency && it.fxRate && it.fxRate > 0) {
      const s = fxInvoiceSettlement(it.due, it.fxRate, remittance, line.credit);
      if (s.problem) {
        pathProblems.push(s.problem);
        noBook = true;
      } else {
        fxPaid = true;
        /* The settlement says what is booked — drop the plan-time "Short by …" guess. */
        for (let n = notes.length - 1; n >= 0; n--) if (notes[n].startsWith("Short by ")) notes.splice(n, 1);
        fxPay = { currency: fx.currency, rate: fx.rate, foreignAmount: fx.foreignAmount, invoiceRate: it.fxRate, foreignDue: s.foreignDue, bankCharges: s.bankCharges, forex: s.forex };
        const parts = [
          s.bankCharges > 0 ? `${rupees(s.bankCharges)} Bank Charges (remitting bank)` : null,
          s.forex < 0 ? `${rupees(-s.forex)} forex gain` : s.forex > 0 ? `${rupees(s.forex)} forex loss` : null,
        ].filter(Boolean);
        summary = `Pays open invoice ${it.invoiceId} (${formatForeign(s.foreignDue, fx.currency, Number.isInteger(s.foreignDue) ? 0 : 2)} at ₹${it.fxRate} = ${rupees(it.due)}) in full${parts.length ? ` — ${parts.join(", ")}` : ""}`;
        notes.push(`Export receipt ${formatRemittance(remittance)}: invoice ${it.invoiceId} was issued at ₹${it.fxRate}; the receipt is its ${rupees(it.due)} due${parts.length ? `, and ${parts.join(" + ")} on the bank line's date` : ""}.`);
      }
    }
    item = { quoteId: it.invoiceId ? null : it.quoteId, invoiceId: it.invoiceId, due: it.due, createSubscription: makeSub, subStart: makeSub ? firstZoho?.start ?? null : null, fx: fxPay };
  };
  const sameMoney = (due: number) => Math.abs(due - money) <= MATCH_SLACK;
  /* R-2427: an invoice in the remittance's currency is matched by its FOREIGN due (Zoho's amount, or what the bank got). */
  const fxHit = (o: OpenItemFact) => !!fx && !!o.invoiceId && o.currency === fx.currency && !!o.fxRate && o.fxRate > 0
    && [fx.billed ?? fx.foreignAmount, fx.foreignAmount].some((a) => Math.abs(o.due / o.fxRate! - a) <= 0.05);
  const itemHits = facts ? facts.openItems.filter((o) => (o.currency && fx ? fxHit(o) : sameMoney(o.due))) : [];
  const severalItems = () => {
    pathProblems.push(`${itemHits.length} open quotes / invoices of ${customer.name} are for ${rupees(money)} (${itemHits.map((o) => o.invoiceId ?? o.quoteId).join(", ")}) — pick the right one in the line's Reconcile.`);
    noBook = true;
  };

  const lastYear = match.invoices.length > 0 && match.invoices.some((inv) => isLastYearInvoice(inv, line.txnDate, opts.booksStart ?? null));
  if (isExisting && facts == null && opts.requireFacts) {
    pathProblems.push("Not checked for doubles: the app's open quotes and receipts for this customer were not read with this line — press Start again to read it afresh.");
    noBook = true;
  } else if (lastYear) {
    kind = "opening";
    const nos = invoiceNumbers.join(", ");
    if (!match.invoices.every((inv) => isLastYearInvoice(inv, line.txnDate, opts.booksStart ?? null))) {
      pathProblems.push(`The Zoho payment mixes last year's and this year's invoices (${nos}) — reconcile this line by hand.`);
      noBook = true;
    } else {
      const reference = (line.reference ?? "").trim() || `BANK-${line.id}`;
      const openings = facts?.openings ?? [];
      const single = match.invoices.length === 1 && match.moreInvoices.length === 0;
      const inv = match.invoices[0];
      const byNo = single && isExisting ? openings.find((o) => normNo(o.number) === normNo(inv.number)) ?? null : null;
      const byAmount = single && isExisting ? openings.filter((o) => sameMoney(o.due)) : [];
      const op = byNo ?? (byAmount.length === 1 ? byAmount[0] : null);
      /* R-2474: each invoice is either an opening invoice the app has (by Zoho number) or one Zoho's
         own invoice history can make. */
      const fromZoho = match.moreInvoices.length === 0 && match.invoices.every((i) =>
        !!i.history || openings.some((o) => normNo(o.number) === normNo(i.number)));
      if (op) {
        summary = `Last year's invoice ${inv.number} — settles its opening balance (${rupees(op.due)} due), no new sale`;
        if (!byNo) notes.push(`Opening invoice ${op.number ?? op.id} matched by amount (Zoho's number is ${inv.number}).`);
        if (line.credit !== Math.round(line.credit)) {
          pathProblems.push(`The bank line has paise (${line.credit}) — a receipt is in whole rupees. Reconcile this line by hand.`);
        } else if (money > op.due) {
          pathProblems.push(`Opening invoice ${op.number ?? op.id} has only ${rupees(op.due)} due, but the bank line${tds ? ` + TDS` : ""} is ${rupees(money)}. Reconcile this line by hand.`);
          noBook = true;
        }
        if (tds > 0 && tdsPctWithin(tds, preview.taxable) === null) pathProblems.push(shortByText(tds, preview.taxable));
        opening = {
          invoiceId: op.id, number: op.number, received: Math.round(line.credit), reference,
          parts: [{ invoiceId: op.id, number: op.number ?? inv.number, amount: Math.round(line.credit), tds, create: null }],
        };
      } else if (single && isExisting && itemHits.length === 1) {
        payItem(itemHits[0]);
      } else if (single && isExisting && itemHits.length > 1) {
        severalItems();
      } else if (fromZoho) {
        /* R-2474: the opening invoice(s) from Zoho's own invoice — as it stood on the books' start
           (1 Apr) — then one receipt across them with this line. */
        const cutoff = opts.booksStart ?? `${fyOf(line.txnDate)}-04-01`;
        const several = match.invoices.length > 1;
        const probs: string[] = [];
        const parts: OpeningPart[] = [];
        let dueSum = 0;
        if (!whole(line.credit)) probs.push(`The bank line has paise (${line.credit}) — a receipt is in whole rupees. Reconcile this line by hand.`);
        if (several && tds > 0) {
          probs.push(`The Zoho payment settles several of last year's invoices (${nos}) with TDS ${rupees(tds)} — Zoho does not say which invoice the TDS is on. Record it in Record payment against those invoices, then match the line by hand.`);
        }
        for (const zi of match.invoices) {
          const amount = several ? zi.amountApplied ?? 0 : Math.round(line.credit);
          const partTds = several ? 0 : tds;
          if (several && (!(amount > 0) || !whole(amount))) {
            probs.push(`Zoho applied ${zi.amountApplied ?? 0} to ${zi.number} — not whole rupees. Reconcile this line by hand.`);
            continue;
          }
          const have = openings.find((o) => normNo(o.number) === normNo(zi.number)) ?? null;
          let due: number;
          let create: OpeningCreate | null = null;
          if (have) {
            due = have.due;
          } else {
            const made = openingFromZoho(zi, cutoff);
            if (!made.ok) { probs.push(made.problem); continue; }
            create = made.create;
            due = made.create.balance;
            notes.push(`Opening invoice ${zi.number} is made from Zoho: total ${rupees(made.create.total)}, ${rupees(made.create.balance)} due on ${fmtDay(cutoff)} — GST and revenue stay in Zoho's books, not counted again.`);
          }
          dueSum += due;
          if (Math.round(amount) + partTds > due) {
            probs.push(`${zi.number} ${have ? "has" : "had"} only ${rupees(due)} due${have ? "" : ` on ${fmtDay(cutoff)}`}, but the bank line${partTds ? " + TDS" : ""}${several ? " puts" : " is"} ${rupees(Math.round(amount) + partTds)}${several ? " on it" : ""}. Reconcile this line by hand.`);
          }
          parts.push({ invoiceId: have?.id ?? null, number: zi.number, amount: Math.round(amount), tds: partTds, create });
        }
        if (several && probs.length === 0) {
          const applied = parts.reduce((s, p) => s + p.amount, 0);
          if (applied !== Math.round(line.credit)) probs.push(`Zoho applied ${rupees(applied)} to ${nos}, but the bank line is ${rupees(line.credit)}. Reconcile this line by hand.`);
        }
        if (!several && tds > 0 && tdsPctWithin(tds, preview.taxable) === null) probs.push(shortByText(tds, preview.taxable));
        if (probs.length) {
          pathProblems.push(...probs);
          noBook = true;
        } else {
          const made = parts.some((p) => p.create);
          summary = `${made ? `Opening invoice${several ? "s" : ""} from Zoho → paid` : "Settles opening balances"}: ${nos} (${rupees(dueSum)} due on ${fmtDay(cutoff)}) — last year's invoice${several ? "s" : ""}, no new sale`;
          opening = { invoiceId: null, number: several ? null : parts[0].number, received: Math.round(line.credit), reference, parts };
        }
      } else if (!isExisting) {
        pathProblems.push(`No opening balance: ${customer.name} is not in the app, so it has no opening balance to settle — ${nos} is last year's invoice, never a new sale. Import Zoho's open invoices (Invoices → Import from Zoho), then run this again.`);
        noBook = true;
      } else if (!single) {
        pathProblems.push(`The Zoho payment settles several of last year's invoices (${nos}) — record it in Record payment against those opening invoices, then match the line by hand.`);
        noBook = true;
      } else {
        pathProblems.push(`No opening balance: ${customer.name} has no open opening invoice ${inv.number} in the app — it is last year's invoice, so it is never booked as a new sale. Import Zoho's open invoices (Invoices → Import from Zoho), or reconcile this line by hand.`);
        noBook = true;
      }
    }
  } else if (isExisting && itemHits.length === 1) {
    payItem(itemHits[0]);
  } else if (isExisting && itemHits.length > 1) {
    severalItems();
  } else if (isExisting && facts) {
    /* (f) the same money from this customer within 35 days. */
    const dup = facts.receipts.find((r) => (Math.abs(r.amount - line.credit) <= MATCH_SLACK || Math.abs(r.amount - money) <= MATCH_SLACK)
      && daysApart(r.date, line.txnDate) <= DOUBLE_DAYS);
    if (dup) {
      doubleProblems.push(`Possible double: ${customer.name} already paid ${rupees(dup.amount)} on ${formatDate(dup.date)}${dup.reference ? ` (ref ${dup.reference})` : ""} — within ${DOUBLE_DAYS} days. Check it is not this payment booked already.`);
    }
  }

  /* R-2425: an export receipt is booked as a new sale in its currency, or (R-2427) pays an open
     invoice in that same currency with the forex / charges lines. Anything else (a ₹ quote or
     invoice, last year's opening invoice) is left for a person. */
  if (fx && kind !== "new_sale" && !fxPaid && !noBook) {
    pathProblems.push(`This export receipt matches ${kind === "opening" ? "last year's invoice" : "an open quote / invoice in ₹"} in the app — it is paid in ${fx.currency} only against an invoice in ${fx.currency}. Reconcile this line by hand.`);
    noBook = true;
  }
  if (fxPaid) {
    /* R-2427: no new sale — the new-sale notes (sale in USD at the bank's rate, renewal quote) do not apply. */
    for (let n = notes.length - 1; n >= 0; n--) {
      if (notes[n].includes(": booked in ") || notes[n].startsWith("The new subscription renews from the app")) notes.splice(n, 1);
    }
  }
  if (fx && kind === "new_sale" && lines.some((l) => l.cycle === "monthly")) {
    saleProblems.push(`A monthly sale in ${fx.currency} is billed in parts — reconcile this line by hand.`);
  }

  const problems = kind === "new_sale"
    ? [...custProblems, ...zohoProblems, ...saleProblems, ...pathProblems, ...doubleProblems, ...payerProblems]
    : kind === "pay_item"
      ? [...custProblems, ...zohoProblems, ...pathProblems, ...payerProblems]
      : [...(isExisting ? [] : custProblems), ...zohoProblems, ...pathProblems, ...payerProblems];

  const externalNumber = zohoSaleNumber({ invoiceNumbers });
  const sale = kind === "new_sale";
  const book: BookSpec | null = noBook ? null : {
    kind,
    item,
    opening,
    lines: sale ? bookLines : [],
    createSubscription: sale ? createSubscription : false,
    subStart: sale && createSubscription && first ? first.start : null,
    subRenewal: sale && createSubscription && first ? first.renewal : null,
    billingCycle: sale && bookLines.some((l) => l.cycle === "monthly") && !bookLines.some((l) => l.cycle === "annual_yearly") ? "monthly" : null,
    externalNumber: sale ? externalNumber : null,
    tdsAmount: tds,
    tdsRatePct: tds > 0 ? rate : null,
    tdsSection: section,
    dateFixes: sale && createSubscription ? dateFixes : [],
    fx: sale ? fx : null,
  };

  return {
    txnId: line.id, txnDate: line.txnDate, credit: line.credit, description: line.description, kind: "match", summary,
    zoho: {
      paymentId: match.payment.zohoId, paymentNumber: match.payment.number || null, by: match.by,
      amount: match.payment.amount, currency: payCur, invoiceNumbers, candidates: 1,
    },
    remittance,
    customer, lines, seatDiffs: sale ? seatDiffs : [], saleTotal: lines.length ? preview.total : null, tds, payer,
    problems, notes, ticked: problems.length === 0 && book !== null, book,
  };
}

/** One answer of the bulk-match route → its plan row; "none" (not in Zoho) → null (left out). */
export function planFromResult(
  line: BulkLine, result: FindZohoResult, contact: ZohoContactInfo | null, ctx: PlanContext, opts: PlanOptions = {},
): PlanRow | null {
  if (result.kind === "none") return null;
  if (result.kind === "several") return severalRow(line, result.candidates.length);
  return planRow(line, result.match, contact, ctx, opts);
}

/**
 * R-2419 — the plan of a whole run. Each row as planFromResult (with the app's facts, which an app
 * customer's row must carry), then (b): of the NEW subscriptions one customer + domain + product
 * would get across the run, only the newest line (Zoho period start, then bank date) makes it; the
 * older lines become charges on it.
 */
export function planAll(rows: readonly BulkMatchRow[], ctx: PlanContext): PlanRow[] {
  const opt = (r: BulkMatchRow, chargeOnNew?: ReadonlyMap<number, { label: string; date: string }>): PlanOptions =>
    ({ facts: r.facts, booksStart: r.booksStart ?? null, requireFacts: true, chargeOnNew });
  const plans = rows.map((r) => planFromResult(r.line, r.result, r.contact, ctx, opt(r)));

  type Cand = { row: number; idx: number; when: string; txn: string; label: string };
  const groups = new Map<string, Cand[]>();
  plans.forEach((p, row) => {
    if (!p || p.kind !== "match" || !p.customer || (p.book && p.book.kind !== "new_sale")) return;
    const ck = p.customer.kind === "existing" ? `id:${p.customer.id}` : newCustomerKey(p.customer);
    p.lines.forEach((l, idx) => {
      if (l.action !== "new_sub") return;
      const key = `${ck}|${l.domain ?? ""}|${normProduct(l.name)}`;
      const list = groups.get(key) ?? [];
      list.push({ row, idx, when: l.start ?? p.txnDate, txn: p.txnDate, label: l.domain ?? l.name });
      groups.set(key, list);
    });
  });
  const demote = new Map<number, Map<number, { label: string; date: string }>>();
  for (const list of groups.values()) {
    if (new Set(list.map((c) => c.row)).size < 2) continue;
    const win = list.reduce((a, b) => (b.when > a.when || (b.when === a.when && (b.txn > a.txn || (b.txn === a.txn && b.row > a.row))) ? b : a));
    for (const c of list) {
      if (c.row === win.row) continue;
      const m = demote.get(c.row) ?? new Map<number, { label: string; date: string }>();
      m.set(c.idx, { label: win.label, date: win.when });
      demote.set(c.row, m);
    }
  }
  return plans.map((p, i) => {
    const d = demote.get(i);
    const r = rows[i];
    return d ? planFromResult(r.line, r.result, r.contact, ctx, opt(r, d)) : p;
  }).filter((p): p is PlanRow => !!p);
}

/** The rows "Book selected" sends: ticked, bookable, not booked already (in this run or before). */
export function rowsToBook(rows: readonly PlanRow[], ticked: ReadonlySet<string>, booked: ReadonlySet<string>): PlanRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (!ticked.has(r.txnId) || !r.book || !r.customer || booked.has(r.txnId) || seen.has(r.txnId)) return false;
    seen.add(r.txnId);
    return true;
  });
}

/** The same company twice in one run (two lines, one new Zoho customer) is created once. */
export const newCustomerKey = (c: Extract<PlanCustomer, { kind: "new" }>) =>
  c.gstin ? `gstin:${c.gstin.toUpperCase()}` : `name:${normCompanyName(c.name)}`;

