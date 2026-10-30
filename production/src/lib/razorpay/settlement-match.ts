/**
 * R-2099 — one Razorpay settlement bank credit, broken back into what it carries.
 *
 * A bank line like "NEFT CR-UTIB0001506-RAZORPAY PAYMENTS PVT LTD PAYMENT AGGREGATOR ESCR-…" is
 * ONE credit for many customer payments, minus Razorpay's fee (+ GST on the fee), minus any
 * refunds Razorpay paid out of it. The app already has those payments (the Razorpay webhook
 * records each one, reference = Razorpay payment id `pay_…`), so reconciling the line means:
 *
 *   1. find the settlement (Razorpay API: /v1/settlements) — by its UTR in the line, else by
 *      the exact amount;
 *   2. list what it settled (/v1/settlements/recon/combined) — payments, refunds, fees, tax;
 *   3. match each Razorpay payment to the app's payment (this file);
 *   4. one click: link the payments to the line, book the fee + GST (reconcile_razorpay_settlement).
 *
 * Pure: no I/O. Amounts from Razorpay are PAISE; the app stores whole RUPEES (CLAUDE.md §13).
 * Each Razorpay figure is rounded to rupees once, here, and the database re-checks everything.
 */

import { rupee } from "@/lib/utils";

/* ── Razorpay shapes (only the fields we read) ─────────────────────────────────────────── */

export interface RzpSettlement {
  id: string;
  /** paise — what reached the bank */
  amount: number;
  /** paise — Razorpay's fees in this settlement, GST included */
  fees: number;
  /** paise — the GST part of `fees` */
  tax: number;
  utr: string | null;
  status?: string;
  /** unix seconds */
  created_at: number;
}

export interface RzpReconItem {
  /** pay_… / rfnd_… / adj_… */
  entity_id: string;
  type: string;
  /** paise */
  amount: number;
  /** paise — reached the merchant (payment: amount − fee) */
  credit: number;
  /** paise — taken from the merchant (refund) */
  debit: number;
  /** paise — fee incl. GST */
  fee: number;
  /** paise — GST on the fee */
  tax: number;
  settlement_id: string | null;
  /** refunds: the payment refunded */
  payment_id?: string | null;
  order_id?: string | null;
  method?: string | null;
  /** unix seconds */
  created_at?: number | null;
  description?: string | null;
}

/* ── The app's side ────────────────────────────────────────────────────────────────────── */

export interface AppPayment {
  id: string;
  reference: string | null;
  /** whole rupees */
  amount: number;
  credit_applied: number;
  status: string;
  received_at: string;
  quote_id: string | null;
  customer_name: string | null;
  /** already linked to a bank line (matched, or payments.bank_txn_id) */
  banked: boolean;
}

export interface BankLine {
  id: string;
  /** rupees (may carry paise from the statement) */
  credit: number;
  txn_date: string;
  reference: string | null;
  description: string;
}

/* ── Helpers ───────────────────────────────────────────────────────────────────────────── */

export const paiseToRupees = (p: number): number => Math.round((Number(p) || 0) / 100);
/**
 * R-2099 (30 Oct 2026, staging): a bank line and a settlement are the same money when they are the
 * same WHOLE RUPEES. Razorpay's fee is 2% + 18% GST, so a settlement carries paise (₹2,534.73),
 * while the statement import stores whole rupees (statement-parse.ts parseAmount rounds) — a
 * paise compare (253473 vs 253500) refused every real line with "₹2,535 but ₹2,535".
 * Both sides are rounded to rupees once; a line that does keep the statement's paise still matches.
 */
export const sameRupees = (settlementPaise: number, lineRupees: number): boolean =>
  paiseToRupees(settlementPaise) === Math.round(Number(lineRupees) || 0);
const cash = (p: AppPayment): number => (Number(p.amount) || 0) - (Number(p.credit_applied) || 0);

/** A money-in line that Razorpay paid: the narration names Razorpay. */
export function isRazorpaySettlementLine(line: { credit?: number | null; description?: string | null }): boolean {
  return (Number(line.credit) || 0) > 0 && /razorpay/i.test(line.description ?? "");
}

/** The settlement this bank line is: its UTR appears in the line, else the one with the exact amount. */
export function pickSettlement(
  line: BankLine,
  settlements: RzpSettlement[],
): { kind: "found"; settlement: RzpSettlement; by: "utr" | "amount" } | { kind: "none" } | { kind: "many"; options: RzpSettlement[] } {
  const hay = `${line.reference ?? ""} ${line.description ?? ""}`.toUpperCase().replace(/\s+/g, "");
  const byUtr = settlements.filter((s) => s.utr && s.utr.trim().length >= 6 && hay.includes(s.utr.trim().toUpperCase()));
  if (byUtr.length === 1) return { kind: "found", settlement: byUtr[0], by: "utr" };
  const byAmount = (byUtr.length > 1 ? byUtr : settlements).filter((s) => sameRupees(s.amount, line.credit));
  if (byAmount.length === 1) return { kind: "found", settlement: byAmount[0], by: "amount" };
  if (byAmount.length > 1) return { kind: "many", options: byAmount };
  return { kind: "none" };
}

/* ── The plan ──────────────────────────────────────────────────────────────────────────── */

export type MatchedBy = "reference" | "order" | "picked";

export interface PlanPayment {
  rzpId: string;
  /** rupees */
  amount: number;
  fee: number;
  tax: number;
  orderId: string | null;
  createdAt: number | null;
  /** app payments this Razorpay payment is (two when the app split one payment, R-1985) */
  paymentIds: string[];
  matchedBy: MatchedBy | null;
  customer: string | null;
  quoteId: string | null;
  /** when unmatched: app payments of the same amount, not in any bank line yet */
  candidates: Array<{ id: string; amount: number; received_at: string; customer_name: string | null; quote_id: string | null; reference: string | null }>;
  problem: string | null;
}

export interface PlanRefund {
  rzpId: string;
  rzpPaymentId: string | null;
  amount: number;
  paymentIds: string[];
  problem: string | null;
}

export interface SettlementPlan {
  settlement: { id: string; utr: string | null; amount: number; createdAt: number };
  payments: PlanPayment[];
  refunds: PlanRefund[];
  totals: {
    /** rupees: sum of the payments' gross */
    gross: number;
    refunds: number;
    /** Razorpay's fee incl. GST */
    fee: number;
    /** GST on the fee */
    feeGst: number;
    /** other Razorpay items (adjustments …), signed: + adds to the bank amount */
    other: number;
    /** what the items add up to (gross − refunds − fee + other) */
    net: number;
    /** the bank line */
    bank: number;
  };
  /** Things that stop the one-click reconcile, in plain English with the next step. */
  blockers: string[];
  ready: boolean;
  /** what reconcile_razorpay_settlement takes — only when ready */
  rpcArg: SettlementRpcArg | null;
}

export interface SettlementRpcArg {
  id: string;
  utr: string | null;
  fee_paise: number;
  tax_paise: number;
  payments: Array<{ rzp_id: string; amount_paise: number; payment_ids: string[] }>;
  refunds: Array<{ rzp_id: string; amount_paise: number; payment_ids: string[] }>;
}

export interface PlanInput {
  line: BankLine;
  settlement: RzpSettlement;
  /** recon items — anything not of this settlement is ignored */
  items: RzpReconItem[];
  /** app payments whose reference is one of the Razorpay payment ids */
  byReference: AppPayment[];
  /** app payments of quotes whose Razorpay order id (quotes.payment_reference) is in the settlement */
  byOrder: Record<string, AppPayment[]>;
  /** unbanked received app payments the owner may pick from (unmatched Razorpay payments) */
  pool: AppPayment[];
  /** owner's picks: Razorpay payment id → app payment id */
  picks?: Record<string, string>;
}

const rs = (n: number) => rupee(n, { decimals: Number.isInteger(n) ? 0 : 2 });
const DAY = 86_400;

export function buildSettlementPlan(input: PlanInput): SettlementPlan {
  const { line, settlement } = input;
  const picks = input.picks ?? {};
  const items = input.items.filter((i) => i.settlement_id === settlement.id);
  const blockers: string[] = [];
  const used = new Set<string>();

  const byRef = new Map<string, AppPayment[]>();
  for (const p of input.byReference) {
    if (!p.reference) continue;
    byRef.set(p.reference, [...(byRef.get(p.reference) ?? []), p]);
  }

  const payments: PlanPayment[] = [];
  for (const it of items.filter((i) => i.type === "payment")) {
    const amount = paiseToRupees(it.amount);
    const row: PlanPayment = {
      rzpId: it.entity_id, amount, fee: paiseToRupees(it.fee), tax: paiseToRupees(it.tax),
      orderId: it.order_id ?? null, createdAt: it.created_at ?? null,
      paymentIds: [], matchedBy: null, customer: null, quoteId: null, candidates: [], problem: null,
    };
    let found: AppPayment[] = (byRef.get(it.entity_id) ?? []).filter((p) => p.status !== "deleted");
    let by: MatchedBy | null = found.length ? "reference" : null;
    if (!found.length && it.order_id) {
      const ofOrder = (input.byOrder[it.order_id] ?? []).filter((p) => !used.has(p.id) && cash(p) === amount);
      if (ofOrder.length === 1) { found = ofOrder; by = "order"; }
    }
    if (!found.length && picks[it.entity_id]) {
      const p = input.pool.find((x) => x.id === picks[it.entity_id]);
      if (p) { found = [p]; by = "picked"; }
    }
    if (found.length) {
      row.paymentIds = found.map((p) => p.id);
      row.matchedBy = by;
      row.customer = found[0].customer_name;
      row.quoteId = found[0].quote_id;
      const sum = found.reduce((s, p) => s + cash(p), 0);
      if (found.some((p) => used.has(p.id))) {
        row.problem = `This app payment is already used for another Razorpay payment in this settlement — pick a different one.`;
      } else if (found.some((p) => p.banked)) {
        row.problem = `The app payment for ${it.entity_id} is already reconciled to another bank line. Un-reconcile that line first if it was matched wrongly.`;
      } else if (sum !== amount) {
        row.problem = `Razorpay says ${rs(amount)} for ${it.entity_id} but the app recorded ${rs(sum)}. Correct the payment in the app (Payments), then fetch again.`;
      }
      found.forEach((p) => used.add(p.id));
    } else {
      const at = it.created_at ?? settlement.created_at;
      row.candidates = input.pool
        .filter((p) => !p.banked && p.status === "received" && cash(p) === amount && !used.has(p.id))
        .filter((p) => Math.abs(Date.parse(p.received_at) / 1000 - at) <= 10 * DAY)
        .map((p) => ({ id: p.id, amount: cash(p), received_at: p.received_at, customer_name: p.customer_name, quote_id: p.quote_id, reference: p.reference }));
      row.problem = `Razorpay payment ${it.entity_id} (${rs(amount)}) is not in the app. Pick the app payment it is, or record it first on its quote with reference ${it.entity_id}, then fetch again.`;
    }
    payments.push(row);
  }

  const refunds: PlanRefund[] = [];
  for (const it of items.filter((i) => i.type === "refund")) {
    const amount = paiseToRupees(it.amount || it.debit);
    const pays = it.payment_id ? (byRef.get(it.payment_id) ?? []) : [];
    const r: PlanRefund = { rzpId: it.entity_id, rzpPaymentId: it.payment_id ?? null, amount, paymentIds: pays.map((p) => p.id), problem: null };
    if (!pays.length) {
      r.problem = `Razorpay refunded ${rs(amount)} (${it.entity_id}) on payment ${it.payment_id ?? "?"}, which is not in the app. Record that payment and its refund first, then fetch again.`;
    } else if (pays.some((p) => p.status !== "refunded")) {
      const sum = pays.reduce((s, p) => s + cash(p), 0);
      r.problem = amount < sum
        ? `Razorpay refunded part (${rs(amount)} of ${rs(sum)}) of payment ${it.payment_id}. The app books only full refunds — record this one by hand, then reconcile this line from the Customer tile.`
        : `Razorpay refunded ${rs(amount)} on payment ${it.payment_id}, but the app still shows it as received. Use Refund on that payment (Payments page) first, then fetch again.`;
    } else if (pays.reduce((s, p) => s + cash(p), 0) !== amount) {
      r.problem = `Razorpay refunded ${rs(amount)} on payment ${it.payment_id}, but the app's refunded payment is ${rs(pays.reduce((s, p) => s + cash(p), 0))}. Check that payment, then fetch again.`;
    }
    refunds.push(r);
  }

  /* Everything else Razorpay put in the settlement (adjustments, transfers, …). */
  const others = items.filter((i) => i.type !== "payment" && i.type !== "refund");
  const otherPaise = others.reduce((s, i) => s + (Number(i.credit) || 0) - (Number(i.debit) || 0), 0);
  if (others.some((i) => (Number(i.credit) || 0) !== 0 || (Number(i.debit) || 0) !== 0)) {
    blockers.push(`This settlement also has ${others.length} Razorpay adjustment(s) (${rs(paiseToRupees(otherPaise))}). The app cannot book those yet — reconcile this line by hand from the Customer tile.`);
  }

  const netPaise = items.reduce((s, i) => s + (Number(i.credit) || 0) - (Number(i.debit) || 0), 0);
  const feePaise = items.reduce((s, i) => s + (Number(i.fee) || 0), 0);
  const taxPaise = items.reduce((s, i) => s + (Number(i.tax) || 0), 0);

  if (!items.length) {
    blockers.push(`Razorpay returned no payments for settlement ${settlement.id} yet. Its report can take a day to appear — try again tomorrow.`);
  } else if (netPaise !== settlement.amount) {
    blockers.push(`Razorpay's items add up to ${rs(paiseToRupees(netPaise))} but the settlement is ${rs(paiseToRupees(settlement.amount))} — the report is incomplete. Try again later.`);
  }
  if (!sameRupees(settlement.amount, line.credit)) {
    blockers.push(`The settlement is ${rs(paiseToRupees(settlement.amount))} but this bank line is ${rs(Number(line.credit) || 0)}. This is not the right settlement for this line.`);
  }
  for (const p of payments) if (p.problem) blockers.push(p.problem);
  for (const r of refunds) if (r.problem) blockers.push(r.problem);

  const gross = payments.reduce((s, p) => s + p.amount, 0);
  const refundTotal = refunds.reduce((s, r) => s + r.amount, 0);
  const ready = blockers.length === 0 && payments.length > 0;

  return {
    settlement: { id: settlement.id, utr: settlement.utr, amount: paiseToRupees(settlement.amount), createdAt: settlement.created_at },
    payments,
    refunds,
    totals: {
      gross,
      refunds: refundTotal,
      fee: paiseToRupees(feePaise),
      feeGst: paiseToRupees(taxPaise),
      other: paiseToRupees(otherPaise),
      net: paiseToRupees(netPaise),
      bank: Number(line.credit) || 0,
    },
    blockers,
    ready,
    rpcArg: ready
      ? {
          id: settlement.id,
          utr: settlement.utr,
          fee_paise: feePaise,
          tax_paise: taxPaise,
          payments: payments.map((p) => ({
            rzp_id: p.rzpId,
            amount_paise: items.find((i) => i.entity_id === p.rzpId)?.amount ?? p.amount * 100,
            payment_ids: p.paymentIds,
          })),
          refunds: refunds.map((r) => ({
            rzp_id: r.rzpId,
            amount_paise: (() => { const i = items.find((x) => x.entity_id === r.rzpId); return i ? (i.amount || i.debit) : r.amount * 100; })(),
            payment_ids: r.paymentIds,
          })),
        }
      : null,
  };
}

/** What the reconcile screen gets back for one bank line. */
export type SettlementLookup =
  | { state: "no_keys"; message: string }
  | { state: "error"; message: string }
  | { state: "not_found"; message: string }
  | { state: "many"; message: string; options: Array<{ id: string; amount: number; utr: string | null; createdAt: number }> }
  | { state: "plan"; plan: SettlementPlan };
