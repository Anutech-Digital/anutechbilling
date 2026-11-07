/**
 * R-2098 — one bank credit pays SEVERAL of a customer's quotes / invoices (+ an optional new sale).
 *
 * Staging, 29 Oct: I-XL ₹11,718 = 3 invoices; Infotrack ₹1,15,710 = 8 invoices + ₹346 left over;
 * Vikas ₹13,087 = Q-0044's ₹169 + a new ₹12,918 sale; Subi Exports ₹16,236 = ₹48 short (Zoho:
 * "Payment Adjustment"). The sheet could book a line on ONE item only.
 *
 * Pure rules for the "Several quotes / invoices" choice of CreditPayForSection. The save is ONE
 * server call (reconcile_bank_credit_split, migration 20261029054707): each item is paid through
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

/** R-1678: "fx" = foreign-currency items settled in full, the difference an exchange gain / loss
 *  (lib/banking/item-fx-pay splitFxPlan decides it, never the operator's round-off choice).
 *  R-2192: "bank_charge" = items settled in full, the shortfall the bank's / SWIFT charge — booked
 *  as a Bank Charges expense (EXP-FXC-<line>, R-2427's row) on the line. */
export type SplitRest = "advance" | "round_off" | "fx" | "bank_charge";

/** R-2192: the largest bank / SWIFT charge on one line, and its largest share of what was settled.
 *  Same numbers as c_charge_max / c_charge_pct in reconcile_bank_credit_split (migration
 *  20261107183500_r2192_small_receipt_differences). More than that is not a bank charge — a part
 *  payment or TDS. */
export const BANK_CHARGE_MAX = 5000;
export const BANK_CHARGE_MAX_PCT = 10;

/** R-2192: may this shortfall on `due` be booked as the bank's charge? */
export function bankChargeAllowed(shortBy: number, due: number): boolean {
  return shortBy > 0 && due > 0 && shortBy <= BANK_CHARGE_MAX && shortBy * 100 <= due * BANK_CHARGE_MAX_PCT;
}

export type SplitState =
  | { kind: "empty" }
  | { kind: "exact" }
  /** More came in than is allocated. */
  | { kind: "left"; left: number; canRoundOff: boolean }
  /** Allocated a little more than came in — only as a round-off. */
  | { kind: "short"; short: number }
  /** Allocated a little more than came in, but an item stays part-paid — no round-off (R-2098):
      refused until that amount is lowered; the rest stays due on it. */
  | { kind: "partShort"; short: number }
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

/** True when any ticked item (or the new sale) gets less than its due — it stays part-paid. */
export function splitPartPaid(picks: ReadonlyArray<{ amount: number; due: number }>): boolean {
  return picks.some((p) => cleanAmount(p.amount) < p.due);
}

/**
 * The bar. R-2098: a round-off (≤ ROUND_OFF_LIMIT) only when, after it, EVERY item is settled in
 * full — with `partPaid` a small extra is advance only and a small shortfall is refused (the same
 * rule as reconcile_bank_credit_split, migration 20261029135130).
 */
export function splitSummary(credit: number, amounts: readonly number[], opts: { partPaid?: boolean } = {}): SplitSummary {
  const partPaid = opts.partPaid ?? false;
  const allocated = amounts.reduce((s, a) => s + cleanAmount(a), 0);
  const left = credit - allocated;
  const state: SplitState = allocated === 0
    ? { kind: "empty" }
    : left === 0
      ? { kind: "exact" }
      : left > 0
        ? { kind: "left", left, canRoundOff: !partPaid && left <= ROUND_OFF_LIMIT }
        : -left <= ROUND_OFF_LIMIT
          ? (partPaid ? { kind: "partShort", short: -left } : { kind: "short", short: -left })
          : { kind: "over", over: -left };
  return { credit, allocated, left, state };
}

/** What the difference becomes — null when there is none, or when it cannot be saved. */
export function splitRest(state: SplitState, choice: SplitRest): SplitRest | null {
  if (state.kind === "left") return choice === "round_off" && state.canRoundOff ? "round_off" : "advance";
  if (state.kind === "short") return "round_off";
  return null;
}

/** Nothing can be saved in this state. */
export function splitBlocked(state: SplitState): boolean {
  return state.kind === "empty" || state.kind === "over" || state.kind === "partShort";
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

/** The bar's three numbers and its tone. R-1678: with an exchange difference nothing is "over" — the gap is booked. */
export function splitBarText(s: SplitSummary, rest: SplitRest | null = null): { allocated: string; bank: string; left: string; tone: "ok" | "warn" | "bad" } {
  const tone = s.state.kind === "exact" ? "ok" : rest === "fx" ? "warn" : s.state.kind === "over" || s.state.kind === "partShort" ? "bad" : "warn";
  const left = s.left >= 0 ? rupee(s.left) : `−${rupee(-s.left)}`;
  return { allocated: rupee(s.allocated), bank: rupee(s.credit), left, tone };
}

/** The sentence under the bar. */
export function splitStateText(state: SplitState, rest: SplitRest | null): string {
  /* R-1678: foreign-currency items — each settled in full; the sheet says what the difference books. */
  if (rest === "fx" && state.kind !== "empty") {
    return state.kind === "exact" ? "Allocated exactly — nothing left over." : "Each invoice is settled in full — the difference is an exchange gain / loss (below), not a due and not TDS.";
  }
  switch (state.kind) {
    case "empty": return "Tick what this money pays — each item gets its full due; change an amount if it was paid in part.";
    case "exact": return "Allocated exactly — nothing left over.";
    case "left":
      return rest === "round_off"
        ? `${rupee(state.left)} more came in — written off as round-off (Bank Charges).`
        : `${rupee(state.left)} left over — kept as the customer's advance credit, used on their next bill.`;
    case "short": return `${rupee(state.short)} less came in than these items — written off as round-off (Bank Charges); every item is settled in full.`;
    case "partShort": return `Allocated ${rupee(state.short)} more than came in. An item is paid in part, so nothing is written off — lower its amount by ${rupee(state.short)}; the rest stays due on it.`;
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
  /** R-2518: this sale's own Zoho invoice number (several sales on one line — one per Zoho invoice). */
  externalNumber?: string | null;
}

export interface SplitInput {
  transactionId: string;
  customerId: string;
  items: ReadonlyArray<Pick<OpenItem, "quote_id" | "invoice_id"> & { amount: number }>;
  /** One new sale, or (R-2518) several — one per Zoho invoice, each with its own externalNumber. */
  sale: SplitSaleInput | readonly SplitSaleInput[] | null;
  rest: SplitRest | null;
  /** R-2360: the Zoho invoice number of the NEW sale (Find in Zoho) — kept on its invoice. */
  externalNumber?: string | null;
}

/** reconcile_bank_credit_split's arguments — exported so the tests pin what reaches the server. */
export function splitArgs(i: SplitInput) {
  const saleArg = (s: SplitSaleInput) => ({
    lines: s.lines,
    billing_cycle: s.billingCycle,
    create_subscription: s.createSubscription,
    sub_start: s.createSubscription ? s.subStart : null,
    sub_renewal: s.createSubscription ? s.subRenewal : null,
    amount: cleanAmount(s.amount),
    /* R-2518: each sale's own Zoho number (stored on its invoice by the RPC). */
    ...(s.externalNumber?.trim() ? { external_number: s.externalNumber.trim() } : {}),
  });
  const several = Array.isArray(i.sale);
  return {
    p_txn_id: i.transactionId,
    p_customer_id: i.customerId,
    p_items: i.items.map((it) => (it.invoice_id
      ? { invoice_id: it.invoice_id, amount: cleanAmount(it.amount) }
      : { quote_id: it.quote_id, amount: cleanAmount(it.amount) })),
    /* R-2518: several sales → an array (one per Zoho invoice); one sale → the object, as before. */
    p_sale: i.sale ? (several ? (i.sale as readonly SplitSaleInput[]).map(saleArg) : saleArg(i.sale as SplitSaleInput)) : null,
    p_rest: i.rest,
    /* R-2360: only with ONE new sale — without it the call resolves to the old 5-argument function. */
    ...(i.sale && !several && i.externalNumber?.trim() ? { p_external_number: i.externalNumber.trim() } : {}),
  };
}
