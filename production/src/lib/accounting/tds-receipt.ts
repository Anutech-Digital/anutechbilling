/**
 * R-523 — what a payment with TDS settled, said the same way everywhere.
 *
 * A customer who deducts TDS pays the bank LESS than the invoice; the rest goes to the
 * government against our PAN. The payment row (`payments.amount`) holds the gross that
 * settles the quote; `tds_receivable` holds the split (`net_paid` + `tds_amount`). Shown
 * as one gross figure, the bank reconciliation can never match (₹1,52,928 on the
 * receipt, ₹1,50,336 in the bank) — so receipts, the statement and Lifetime paid say
 * "Received ₹A + TDS ₹B = ₹C".
 *
 * Also: the one sentence the Record payment drawer says about how the quote ends up
 * (it used to say "fully paid" and "₹X outstanding" together), and the owner report of
 * past TDS entries whose rate does not fit their section.
 */
import { paymentMethodLabel } from "@/lib/payments/method-label";
import { checkTdsRate } from "./tds-rates";
import { tdsEntryMismatch, TDS_GST_INCLUSIVE_REASON, type InvoiceTaxLike } from "./tds-mismatch";
import { rupee } from "@/lib/utils";

/* R-1138: the shared formatter (lakh grouping, sign, rounding) — not a local copy. */
const inr = (n: number) => rupee(n);

export interface ReceiptSplit {
  /** Money that reached the bank. */
  received: number;
  /** Deducted by the customer, deposited with the government. */
  tds: number;
  /** received + tds — what the payment settles. */
  gross: number;
}

/** Split of a payment's gross. `tds` null/0 → nothing deducted, all of it is bank money. */
export function receiptSplit(gross: number, tds: number | null | undefined): ReceiptSplit {
  const g = Math.round(gross || 0);
  const t = Math.max(0, Math.min(g, Math.round(tds || 0)));
  return { received: g - t, tds: t, gross: g };
}

/** "Received ₹1,50,336 + TDS ₹2,592 = ₹1,52,928"; null when no TDS was deducted. */
export function receiptSplitLine(gross: number, tds: number | null | undefined): string | null {
  const s = receiptSplit(gross, tds);
  if (s.tds <= 0) return null;
  return `Received ${inr(s.received)} + TDS ${inr(s.tds)} = ${inr(s.gross)}`;
}

/**
 * R-1119 — the pre-GST base TDS is deducted on. A customer deducts TDS on the value
 * before GST, so the GST inside the amount is stripped at the quote's OWN rate. The old
 * shortcut `amount × 100/118` assumed 18% everywhere, so a 5% or 0% (export/LUT) quote got
 * a base — and a TDS receivable — that never matched 26AS.
 * `taxRatePct` null/absent (old rows) → 18%, as before; a negative or non-number rate
 * also falls back to 18% rather than inflating the base. Whole rupees, rounded once.
 */
export function tdsBase(amountInclGst: number, taxRatePct: number | null | undefined): number {
  const r = typeof taxRatePct === "number" && Number.isFinite(taxRatePct) && taxRatePct >= 0 ? taxRatePct : 18;
  return Math.round((amountInclGst || 0) * 100 / (100 + r));
}

/** round(a × b ÷ c) for whole non-negative numbers, half away from zero like SQL's numeric round —
 *  in BigInt, so crore × crore never drifts. */
function mulDivRound(a: number, b: number, c: number): number {
  const A = BigInt(a), B = BigInt(b), C = BigInt(c);
  return Number((2n * A * B + C) / (2n * C));
}

/**
 * R-2551 — the TDS gross of a receipt that may pay only a PART of a document: the twin of R-2538's
 * SQL helpers bank_credit_tds_part_gross + bank_credit_tds_gross (migration 20261107074500), so the
 * desk Record payment sheet books what the bank-reconcile path books.
 * - gross = paid (money + TDS) × taxable ÷ GST-inclusive total, whole rupees, never above the taxable;
 *   paid ≥ total (or no usable total) → the whole taxable.
 * - a rate is given and the TDS does not fit it on that part (±₹1 is rounding) — the customer deducted
 *   on more than this part — → TDS × 100 ÷ rate, never above the taxable (what 26AS shows).
 * - never null: no taxable value → 0.
 * Integer (BigInt) arithmetic with the rate to 6 decimals, so it gives the SQL helper's answer exactly.
 */
export function tdsPartGross(i: {
  paid: number;
  taxable: number | null | undefined;
  total: number | null | undefined;
  tds: number | null | undefined;
  ratePct: number | null | undefined;
}): number {
  const whole = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 0);
  const taxable = whole(i.taxable);
  const total = whole(i.total);
  const paid = whole(i.paid);
  const tds = whole(i.tds);
  if (taxable <= 0) return 0;
  let part: number;
  if (total <= 0 || paid >= total) part = taxable;
  else if (paid <= 0) part = 0;
  else part = Math.min(taxable, mulDivRound(paid, taxable, total));
  // The rate in millionths of a % (0.125% → 125000): exact for any rate typed with up to 6 decimals.
  const rateM = typeof i.ratePct === "number" && Number.isFinite(i.ratePct) ? Math.round(i.ratePct * 1_000_000) : 0;
  if (tds > 0 && rateM > 0 && Math.abs(mulDivRound(part, rateM, 100_000_000) - tds) > 1) {
    return Math.min(taxable, mulDivRound(tds, 100_000_000, rateM));
  }
  return part;
}

/**
 * R-2556 — the Record payment sheet's DEFAULT TDS when part of the document may already be paid.
 * - partTaxable = the taxable share of THIS payment's part (the balance it settles), by the same part
 *   rule as tdsPartGross (R-2551 / SQL bank_credit_tds_gross): remaining × taxable ÷ GST-inclusive total.
 * - tds = rate × partTaxable, half away from zero, rate exact to 6 decimals (0.125% stays exact).
 * - and never more than the document's TDS at that rate minus the TDS already booked on its earlier
 *   parts (`bookedTds`; null = not known yet → only the part rule), so earlier TDS is never added again.
 * Nothing paid before → remaining = total → rate × the whole taxable, exactly as before.
 */
export function tdsDefaultForPart(i: {
  remaining: number;
  taxable: number | null | undefined;
  total: number | null | undefined;
  ratePct: number | null | undefined;
  bookedTds: number | null | undefined;
}): { partTaxable: number; tds: number } {
  const remaining = Math.max(0, Math.round(i.remaining || 0));
  const taxable = typeof i.taxable === "number" && Number.isFinite(i.taxable) ? Math.max(0, Math.round(i.taxable)) : 0;
  const partTaxable = remaining > 0 ? tdsPartGross({ paid: remaining, taxable, total: i.total, tds: 0, ratePct: null }) : 0;
  const rateM = typeof i.ratePct === "number" && Number.isFinite(i.ratePct) && i.ratePct > 0
    ? Math.round(i.ratePct * 1_000_000) : 0;
  if (rateM <= 0 || partTaxable <= 0) return { partTaxable, tds: 0 };
  let tds = mulDivRound(partTaxable, rateM, 100_000_000);
  if (typeof i.bookedTds === "number" && Number.isFinite(i.bookedTds)) {
    const left = mulDivRound(taxable, rateM, 100_000_000) - Math.max(0, Math.round(i.bookedTds));
    tds = Math.max(0, Math.min(tds, left));
  }
  return { partTaxable, tds };
}

/** A tds_receivable row as the Record payment sheet reads it (R-2556). */
export interface BookedTdsRow { tds_amount: number | null; rate_pct: number | string | null }

/**
 * R-2556 — TDS already booked on a document at THIS rate (rate compared to 6 decimals). TDS booked under
 * another section/rate (194J 10% earlier, 194C 2% now) does not count: subtracting it would wrongly cap
 * this part's TDS to ₹0.
 */
export function bookedTdsAtRate(rows: readonly BookedTdsRow[], ratePct: number | null | undefined): number {
  const m = (r: unknown) => {
    const n = typeof r === "string" ? Number(r) : r;
    return typeof n === "number" && Number.isFinite(n) ? Math.round(n * 1_000_000) : NaN;
  };
  const want = m(ratePct);
  return rows.reduce((s, r) => (m(r.rate_pct) === want ? s + Math.max(0, Math.round(r.tds_amount ?? 0)) : s), 0);
}

/** Sum of TDS per payment id, from tds_receivable rows (one payment can carry more than one). */
export function tdsByPayment(rows: readonly { payment_id: string | null; tds_amount: number | null }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (!r.payment_id) continue;
    out[r.payment_id] = (out[r.payment_id] ?? 0) + Math.max(0, Math.round(r.tds_amount ?? 0));
  }
  return out;
}

export type PaymentOutcomeKind = "none" | "partial" | "full" | "over";

export interface PaymentOutcome {
  kind: PaymentOutcomeKind;
  /** Still owed after this payment (0 unless partial). */
  due: number;
  /** Settled beyond the quote total (0 unless over). */
  excess: number;
  /** The ONE sentence the drawer shows about the quote's state after saving. */
  sentence: string;
}

/**
 * How the quote ends up after this payment. `settled` = bank amount + TDS + credit applied.
 * Every place in the drawer that talks about "fully paid" / "outstanding" reads this, so
 * two boxes can never disagree.
 */
export function paymentOutcome(i: { expected: number; alreadyReceived: number; settled: number }): PaymentOutcome {
  const expected = Math.max(0, Math.round(i.expected || 0));
  const total = Math.max(0, Math.round(i.alreadyReceived || 0)) + Math.max(0, Math.round(i.settled || 0));
  if (Math.round(i.settled || 0) <= 0) {
    return { kind: "none", due: Math.max(0, expected - total), excess: 0, sentence: "Enter the amount received to see how the quote ends up." };
  }
  if (total < expected) {
    const due = expected - total;
    return { kind: "partial", due, excess: 0, sentence: `${inr(due)} will still be outstanding — the quote stays partly paid.` };
  }
  if (total > expected) {
    const excess = total - expected;
    return { kind: "over", due: 0, excess, sentence: `Quote will be marked fully paid, with ${inr(excess)} more than it was due.` };
  }
  return { kind: "full", due: 0, excess: 0, sentence: "Quote will be marked fully paid." };
}

export interface TdsEntryLike {
  id: string;
  customer_name: string;
  section: string;
  rate_pct: number | string;
  tds_amount: number;
  payment_received_date: string;
  /** R-2047: read to find TDS deducted on the GST-inclusive amount. */
  gross_amount?: number | null;
  invoice_id?: string | null;
}

export interface TdsRateMismatch<T extends TdsEntryLike> {
  entry: T;
  defaultPct: number;
  knownVariant: boolean;
  message: string;
  /** R-2047: "rate" = the rate is not the section's usual one (R-523); "gst_inclusive" = the
   *  rate is fine but TDS was deducted on the amount including GST. */
  reason: "rate" | "gst_inclusive";
  /** Badge text for a gst_inclusive entry (TDS_GST_INCLUSIVE_REASON); null for a rate entry. */
  reasonLabel: string | null;
}

/** Owner report: past entries whose rate is not their section's default, and (R-2047, when
 *  the invoices' tax is given) entries whose TDS was deducted on the GST-inclusive amount.
 *  Read-only — past entries are never changed; the owner decides with the CA. Firm rate
 *  mismatches first, then GST-inclusive, then the section's other lawful rate. */
export function tdsRateMismatches<T extends TdsEntryLike>(
  rows: readonly T[],
  taxByInvoice?: Readonly<Record<string, InvoiceTaxLike>> | null,
): TdsRateMismatch<T>[] {
  const out: TdsRateMismatch<T>[] = [];
  for (const entry of rows) {
    const c = checkTdsRate(entry.section, Number(entry.rate_pct));
    const m = taxByInvoice ? tdsEntryMismatch(entry, taxByInvoice) : null;
    const onGst = m?.kind === "gst_inclusive" ? m : null;
    if (!c.matches && c.defaultPct !== null && c.message) {
      out.push({
        entry, defaultPct: c.defaultPct, knownVariant: c.knownVariant,
        message: onGst ? `${c.message} ${onGst.note}` : c.message,
        reason: "rate", reasonLabel: null,
      });
    } else if (onGst) {
      out.push({
        entry, defaultPct: c.defaultPct ?? Number(entry.rate_pct), knownVariant: false,
        message: onGst.note, reason: "gst_inclusive", reasonLabel: TDS_GST_INCLUSIVE_REASON,
      });
    }
  }
  const rank = (x: TdsRateMismatch<T>) => (x.reason === "gst_inclusive" ? 1 : x.knownVariant ? 2 : 0);
  return out.sort((a, b) =>
    rank(a) - rank(b) ||
    (b.entry.payment_received_date ?? "").localeCompare(a.entry.payment_received_date ?? ""));
}

/** One printed line of an invoice's "Advances adjusted" block. */
export interface AdvanceLine {
  key: string;
  voucherNo: string | null;
  receivedAt: string;
  /** The payment method as stored ("bank_transfer"), or "tds" for the TDS line. */
  method: string;
  amount: number;
}

/**
 * R-1670 (2) — an advance the customer paid with TDS deducted, shown as what reached the bank
 * plus the TDS, not one gross figure. The invoice said "Bank transfer ₹1,52,928" while the bank
 * got ₹1,50,336 and ₹2,592 went to the government, so the reconciliation could never match.
 * Same split as the receipt (receiptSplit). The total adjusted is unchanged.
 * `tdsByPaymentId` from tds_receivable (tdsByPayment); absent → every line as before.
 */
export function advanceLinesWithTds(
  advances: readonly { payment_id: string; voucher_no: string | null; received_at: string; method: string; amount: number }[],
  tdsByPaymentId: Readonly<Record<string, number>> | null | undefined,
): AdvanceLine[] {
  const out: AdvanceLine[] = [];
  advances.forEach((a, i) => {
    const split = receiptSplit(a.amount, tdsByPaymentId?.[a.payment_id]);
    const key = `${a.payment_id}-${i}`;
    out.push({ key, voucherNo: a.voucher_no, receivedAt: a.received_at, method: a.method, amount: split.tds > 0 ? split.received : a.amount });
    if (split.tds > 0) out.push({ key: `${key}-tds`, voucherNo: null, receivedAt: a.received_at, method: "tds", amount: split.tds });
  });
  return out;
}

/** "Bank transfer", "TDS deducted by customer" — the method words of an advance line. */
export function advanceMethodLabel(method: string): string {
  if (method === "tds") return "TDS deducted by customer";
  /* R-1715 / R-1680: every other method from the one payment-method map ("UPI", not "Upi"). */
  return paymentMethodLabel(method);
}
