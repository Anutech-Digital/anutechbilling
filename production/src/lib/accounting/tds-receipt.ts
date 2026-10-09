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

const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

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
