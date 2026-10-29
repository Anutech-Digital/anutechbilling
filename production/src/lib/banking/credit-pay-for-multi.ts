/**
 * R-2098 — one bank credit pays SEVERAL of a customer's quotes / invoices (+ an optional new sale).
 *
 * Staging, 29 Oct: I-XL ₹11,718 = 3 invoices; Infotrack ₹1,15,710 = 8 invoices + ₹346 left over;
 * Vikas ₹13,087 = Q-0044's ₹169 + a new ₹12,918 sale; Subi Exports ₹16,236 = ₹48 short (Zoho:
 * "Payment Adjustment"). The sheet could book a line on ONE item only.
 *
 * Pure rules for the "Several quotes / invoices" choice of CreditPayForSection. The save is ONE
 * server call (reconcile_bank_credit_split, migration 20261029045721): each item is paid through
 * the same per-item path as the single choice; the rest is the customer's advance or, up to
 * ROUND_OFF_LIMIT, a round-off (P&L Bank Charges — "Settlement short of receipt").
 */
import { rupee } from "@/lib/utils";
import type { OpenItem } from "@/lib/banking/credit-pay-for";
import { itemKey } from "@/lib/banking/credit-pay-for";

/** The largest difference written off as round-off. Same number as c_limit in the SQL. */
export const ROUND_OFF_LIMIT = 50;

/** A ticked item and the part of the bank credit put on it. */
export interface SplitPick { key: string; amount: number }

export type SplitRest = "advance" | "round_off";

export type SplitState =
  | { kind: "empty" }
  | { kind: "exact" }
  /** More came in than is allocated. */
  | { kind: "left"; left: number; canRoundOff: boolean }
  /** Allocated a little more than came in — only as a round-off. */
  | { kind: "short"; short: number }
  /** Allocated more than came in, beyond the round-off limit — refused. */
  | { kind: "over"; over: number };

export interface SplitSummary {
  credit: number;
  allocated: number;
  /** credit − allocated (negative = over-allocated). */
  left: number;
  state: SplitState;
}

/** Whole rupees, never negative. */
export function cleanAmount(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

export function splitSummary(credit: number, amounts: readonly number[]): SplitSummary {
  const allocated = amounts.reduce((s, a) => s + cleanAmount(a), 0);
  const left = credit - allocated;
  const state: SplitState = allocated === 0
    ? { kind: "empty" }
    : left === 0
      ? { kind: "exact" }
      : left > 0
        ? { kind: "left", left, canRoundOff: left <= ROUND_OFF_LIMIT }
        : -left <= ROUND_OFF_LIMIT
          ? { kind: "short", short: -left }
          : { kind: "over", over: -left };
  return { credit, allocated, left, state };
}

/** What the difference becomes — null when there is none, or when it cannot be saved. */
export function splitRest(state: SplitState, choice: SplitRest): SplitRest | null {
  if (state.kind === "left") return choice === "round_off" && state.canRoundOff ? "round_off" : "advance";
  if (state.kind === "short") return "round_off";
  return null;
}

/** Per-item problem, or null: an amount must be more than ₹0 and no more than the item's due. */
export function pickProblem(item: Pick<OpenItem, "amount_due">, amount: number): string | null {
  const a = cleanAmount(amount);
  if (a <= 0) return "Enter an amount";
  if (a > item.amount_due) return `More than the ${rupee(item.amount_due)} due`;
  return null;
}

/** Ticking an item puts its whole due on it (the card: "amount per item defaulting to its due"). */
export function pickDefault(item: OpenItem): SplitPick {
  return { key: itemKey(item), amount: item.amount_due };
}

/** The bar's three numbers and its tone. */
export function splitBarText(s: SplitSummary): { allocated: string; bank: string; left: string; tone: "ok" | "warn" | "bad" } {
  const tone = s.state.kind === "exact" ? "ok" : s.state.kind === "over" ? "bad" : "warn";
  const left = s.left >= 0 ? rupee(s.left) : `−${rupee(-s.left)}`;
  return { allocated: rupee(s.allocated), bank: rupee(s.credit), left, tone };
}

/** The sentence under the bar. */
export function splitStateText(state: SplitState, rest: SplitRest | null): string {
  switch (state.kind) {
    case "empty": return "Tick what this money pays — each item gets its full due; change an amount if it was paid in part.";
    case "exact": return "Allocated exactly — nothing left over.";
    case "left":
      return rest === "round_off"
        ? `${rupee(state.left)} more came in — written off as round-off (Bank Charges).`
        : `${rupee(state.left)} left over — kept as the customer's advance credit, used on their next bill.`;
    case "short": return `${rupee(state.short)} less came in than these items — written off as round-off (Bank Charges); every item is settled in full.`;
    case "over": return `Allocated ${rupee(state.over)} more than came in. Lower an amount — only up to ${rupee(ROUND_OFF_LIMIT)} can be written off.`;
  }
}

export interface SplitSaleInput {
  lines: unknown;
  billingCycle: string | null;
  createSubscription: boolean;
  subStart: string | null;
  subRenewal: string | null;
  amount: number;
}

export interface SplitInput {
  transactionId: string;
  customerId: string;
  items: ReadonlyArray<Pick<OpenItem, "quote_id" | "invoice_id"> & { amount: number }>;
  sale: SplitSaleInput | null;
  rest: SplitRest | null;
}

/** reconcile_bank_credit_split's arguments — exported so the tests pin what reaches the server. */
export function splitArgs(i: SplitInput) {
  return {
    p_txn_id: i.transactionId,
    p_customer_id: i.customerId,
    p_items: i.items.map((it) => (it.invoice_id
      ? { invoice_id: it.invoice_id, amount: cleanAmount(it.amount) }
      : { quote_id: it.quote_id, amount: cleanAmount(it.amount) })),
    p_sale: i.sale
      ? {
          lines: i.sale.lines,
          billing_cycle: i.sale.billingCycle,
          create_subscription: i.sale.createSubscription,
          sub_start: i.sale.createSubscription ? i.sale.subStart : null,
          sub_renewal: i.sale.createSubscription ? i.sale.subRenewal : null,
          amount: cleanAmount(i.sale.amount),
        }
      : null,
    p_rest: i.rest,
  };
}
