/**
 * R-109 — which OPEN INVOICE did this bank credit pay?
 *
 * `suggest_bank_transaction_matches` only proposes payments that are already recorded, and
 * `lib/accounting/credit-match.ts` matches against quotes. The commonest stranded deposit is
 * neither: an invoice was raised, the customer paid by UPI/NEFT straight into the bank, and
 * nobody pressed "Record payment". This module ranks the open invoices a credit could have
 * settled so the reconcile drawer can offer ONE operator click: record the payment on that
 * invoice and reconcile the line to it.
 *
 * Signals, strongest first:
 *   1. The invoice number (or its quote id) appears in the narration / reference.
 *   2. The amount equals what is still due (`invoiceAmountDue`, R-371) to the rupee.
 *   3. A distinctive word of the customer's name appears in the narration (`nameOverlap`).
 *   4. Date: money normally arrives after the invoice; closer is a little better.
 *
 * TDS: a B2B customer often pays the invoice LESS 1/2/10% TDS on the taxable value. That
 * deposit is the right invoice but the WRONG amount to record as a plain payment — the TDS
 * leg has to be booked as TDS receivable (the Record payment dialog does that). So a
 * TDS-short candidate is flagged and never offered as one-click.
 *
 * Nothing here writes. `oneClick` only says the drawer may show the "Match & record
 * payment" button; the operator still clicks it (see `canAutoApply` in credit-match.ts).
 */
import { nameOverlap } from "@/lib/accounting/credit-match";

export interface CreditLine {
  /** Whole rupees credited. */
  amount: number;
  /** YYYY-MM-DD. */
  txnDate: string;
  description: string | null;
  reference: string | null;
}

export interface OpenInvoice {
  id: string;
  /** record_payment is quote-keyed; an invoice without one cannot be one-clicked. */
  quoteId: string | null;
  customerName: string | null;
  /** YYYY-MM-DD. */
  invoiceDate: string;
  /** Rupees still owed — from invoiceAmountDue(), never recomputed here. */
  amountDue: number;
  /** Ex-GST value — the base TDS is deducted on. Null when unknown. */
  taxableValue: number | null;
  /** Project-milestone invoices are paid through project_payments, not record_payment. */
  isProject?: boolean;
}

export type InvoiceMatchConfidence = "certain" | "likely" | "possible";

export interface InvoiceMatch {
  invoiceId: string;
  quoteId: string | null;
  customerName: string | null;
  amountDue: number;
  /** 0–100. For ordering and display only — never a threshold for writing. */
  score: number;
  confidence: InvoiceMatchConfidence;
  /** Plain-English reasons, shown on the row. */
  reasons: string[];
  /** Credit == due to the rupee. */
  exactAmount: boolean;
  /** Credit looks like due minus TDS at this rate (%), else null. */
  tdsRatePct: number | null;
  /** Rupees short of the due amount (credit < due), 0 otherwise. */
  shortBy: number;
  /** Deposit larger than the due amount. */
  overBy: number;
  /** May the drawer show the one-click "Match & record payment" button? */
  oneClick: boolean;
  /** Why it is not one-click, when it is not. */
  blockedReason: string | null;
}

/** Common TDS rates on services (194C 1/2%, 194J 2/10%, 194H 5%). */
export const TDS_RATES_PCT = [1, 2, 5, 10] as const;
/** Banks and TDS rounding drift a rupee or two; more than that is a different amount. */
export const TDS_TOLERANCE = 2;
/** Older than this, an invoice is still owed but no longer plausibly what today's money paid. */
export const MAX_INVOICE_AGE_DAYS = 365;
/** Money a couple of days BEFORE the invoice date (paid against the quote / proforma). */
export const MAX_DAYS_BEFORE_INVOICE = 7;

const inr = (n: number) => n.toLocaleString("en-IN");
const norm = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO.slice(0, 10)}T00:00:00+05:30`);
  const b = Date.parse(`${toISO.slice(0, 10)}T00:00:00+05:30`);
  return Math.round((b - a) / 86_400_000);
}

/** Does the narration/reference carry this document number? Whole id only — a bare "0013" matches too much. */
export function referencesDocument(credit: Pick<CreditLine, "description" | "reference">, docId: string | null): boolean {
  const id = norm(docId);
  if (id.length < 6) return false;
  return norm(credit.description).includes(id) || norm(credit.reference).includes(id);
}

/** Which TDS rate, if any, explains `credit` being short of `due`. */
export function tdsRateFor(credit: number, due: number, taxableValue: number | null): number | null {
  if (credit >= due) return null;
  const base = taxableValue && taxableValue > 0 ? taxableValue : null;
  for (const r of TDS_RATES_PCT) {
    const candidates = base !== null ? [base] : [];
    // Without a taxable value, try 18% GST-inclusive (the usual case) as the base.
    if (base === null) candidates.push(Math.round(due / 1.18));
    for (const b of candidates) {
      const tds = Math.round((b * r) / 100);
      if (Math.abs(due - tds - credit) <= TDS_TOLERANCE) return r;
    }
  }
  return null;
}

/**
 * Rank the open invoices this credit could have paid. Best first; empty when nothing is
 * plausible — an empty list is a good answer, a wrong suggestion is not.
 */
export function matchCreditToInvoices(credit: CreditLine, invoices: readonly OpenInvoice[]): InvoiceMatch[] {
  const amount = Math.round(credit.amount);
  if (!(amount > 0)) return [];
  const out: InvoiceMatch[] = [];

  for (const inv of invoices) {
    const due = Math.round(inv.amountDue);
    if (!(due > 0)) continue;
    const age = daysBetween(inv.invoiceDate, credit.txnDate);
    if (age < -MAX_DAYS_BEFORE_INVOICE || age > MAX_INVOICE_AGE_DAYS) continue;

    const refHit = referencesDocument(credit, inv.id) || referencesDocument(credit, inv.quoteId);
    const nameHit = nameOverlap(credit.description, inv.customerName);
    const exactAmount = amount === due;
    const tdsRatePct = exactAmount ? null : tdsRateFor(amount, due, inv.taxableValue);
    if (!refHit && !nameHit && !exactAmount && tdsRatePct === null) continue;

    const reasons: string[] = [];
    let score = 0;
    if (refHit) { score += 45; reasons.push(`Narration carries ${inv.id}`); }
    if (exactAmount) { score += 35; reasons.push("Exact amount due"); }
    else if (tdsRatePct !== null) { score += 25; reasons.push(`Due less ${tdsRatePct}% TDS`); }
    if (nameHit) { score += 20; reasons.push(`Narration says “${nameHit}”`); }
    // Date: up to 5 points, highest within a month of the invoice.
    if (age >= -MAX_DAYS_BEFORE_INVOICE && age <= 30) score += 5;
    else if (age <= 90) score += 3;
    score = Math.min(100, score);

    const strongIdentity = refHit || Boolean(nameHit);
    const amountFits = exactAmount || tdsRatePct !== null;
    const confidence: InvoiceMatchConfidence =
      strongIdentity && amountFits ? "certain" : amountFits || refHit ? "likely" : "possible";

    out.push({
      invoiceId: inv.id, quoteId: inv.quoteId, customerName: inv.customerName, amountDue: due,
      score, confidence, reasons, exactAmount, tdsRatePct,
      shortBy: Math.max(0, due - amount), overBy: Math.max(0, amount - due),
      oneClick: false, blockedReason: null,
    });
  }

  /* Two invoices with the same due and no name/ref telling them apart: an amount alone
     cannot choose, so neither is "likely" — both drop to "possible" and lose one-click.
     Two customers on the same plan paying the same day is the normal case, not rare. */
  const exactNoIdentity = out.filter((m) => m.exactAmount && !m.reasons.some((r) => r.startsWith("Narration")));
  const exactCount = out.filter((m) => m.exactAmount).length;
  if (exactNoIdentity.length > 0 && exactCount > 1) {
    for (const m of exactNoIdentity) {
      m.confidence = "possible";
      m.score = Math.min(m.score, 40);
      m.reasons.push("Another open invoice has the same amount");
    }
  }

  const byId = new Map(invoices.map((i) => [i.id, i]));
  for (const m of out) {
    const inv = byId.get(m.invoiceId);
    m.blockedReason =
      inv?.isProject ? "Project invoice — record it as a project payment"
      : !m.quoteId ? "No quote behind this invoice — record the payment from the invoice"
      : m.tdsRatePct !== null ? `Short by ₹${inr(m.shortBy)} — looks like ${m.tdsRatePct}% TDS; record it with TDS from the invoice`
      : !m.exactAmount ? (m.overBy > 0 ? `Deposit is ₹${inr(m.overBy)} more than due` : `Deposit is ₹${inr(m.shortBy)} short of due`)
      : m.confidence === "possible" ? "Same amount as another invoice — open the invoice to be sure"
      : null;
    m.oneClick = m.blockedReason === null;
  }

  const rank: Record<InvoiceMatchConfidence, number> = { certain: 0, likely: 1, possible: 2 };
  return out.sort((a, b) => rank[a.confidence] - rank[b.confidence] || b.score - a.score || a.invoiceId.localeCompare(b.invoiceId));
}

/** The bank-line fields the list chip needs (a subset of BankTransactionRow). */
export interface ChipTxn {
  id: string;
  credit: number;
  txn_date: string;
  description: string | null;
  reference: string | null;
  matched_to_type: string | null;
}

/**
 * R-399: the "Matches INV-…" chip on the banking transaction list. For every UNMATCHED
 * credit line whose best candidate is "certain" (name or invoice no. in the narration AND
 * the amount fits), the invoice it most likely paid. Two "certain" candidates for one line
 * (same customer, same amount, two invoices) get NO chip — the drawer lists both and the
 * operator picks; a chip naming one of them would be a guess dressed as a fact.
 *
 * The chip only points; it never records anything. Clicking it opens the same reconcile
 * drawer, where InvoiceCreditMatchSection shows the reasons and the one-click button.
 */
export function certainInvoiceMatches(
  txns: readonly ChipTxn[],
  invoices: readonly OpenInvoice[],
): Map<string, InvoiceMatch> {
  const out = new Map<string, InvoiceMatch>();
  if (invoices.length === 0) return out;
  for (const t of txns) {
    if (t.matched_to_type !== null || !(t.credit > 0)) continue;
    const ms = matchCreditToInvoices(
      { amount: t.credit, txnDate: t.txn_date, description: t.description, reference: t.reference },
      invoices,
    );
    if (ms[0]?.confidence === "certain" && ms[1]?.confidence !== "certain") out.set(t.id, ms[0]);
  }
  return out;
}
