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
import { checkTdsRate } from "./tds-rates";
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
}

export interface TdsRateMismatch<T extends TdsEntryLike> {
  entry: T;
  defaultPct: number;
  knownVariant: boolean;
  message: string;
}

/** Owner report: past entries whose rate is not their section's default. Read-only —
 *  past entries are never changed; the owner decides with the CA. Firm mismatches first. */
export function tdsRateMismatches<T extends TdsEntryLike>(rows: readonly T[]): TdsRateMismatch<T>[] {
  const out: TdsRateMismatch<T>[] = [];
  for (const entry of rows) {
    const c = checkTdsRate(entry.section, Number(entry.rate_pct));
    if (c.matches || c.defaultPct === null || !c.message) continue;
    out.push({ entry, defaultPct: c.defaultPct, knownVariant: c.knownVariant, message: c.message });
  }
  return out.sort((a, b) =>
    Number(a.knownVariant) - Number(b.knownVariant) ||
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
  const words = method.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
