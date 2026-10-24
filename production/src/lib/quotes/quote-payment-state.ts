/**
 * R-1710 (24 Oct 2026) — a quote's payment state from MONEY, next to its stage.
 *
 * `payment_status = 'invoiced'` carries two meanings in one field: "an invoice exists" and,
 * read as a payment state, nothing at all about the money. Once a quote was invoiced the
 * "half paid" fact vanished (billing audit T-A1: ₹20,000 of ₹38,232 came in before the
 * invoice; the stepper said "Invoiced before payment", the header "Accepted · Invoiced", and
 * the Partial quotes tile 0 — lifecycle.ts:107-113, focus.ts:36).
 *
 * The state comes from R-1624's one mapping (lib/checkout/order-payment-state.ts): 'invoiced'
 * is answered from the money received (`payment_amount`, which record_payment keeps as the
 * total received, also after the invoice — 20261021023154_r1703…sql:719) against the total.
 * A "part-paid" quote must also still owe something: with R-1707's open balance (credit notes
 * and refunds counted) at 0 there is nothing part-paid to chase.
 */
import { orderPaymentState, type OrderPaymentState } from "@/lib/checkout/order-payment-state";
import { quoteBalanceDue } from "./list-tab";
import { rupee } from "@/lib/utils";

export interface QuoteMoneyFacts {
  payment_status?: string | null;
  amount?: number | null;
  /** quotes.payment_amount — total received against the quote. */
  payment_amount?: number | null;
  /** R-1707: quote_open_balance(); null/absent = not loaded. */
  open_balance?: number | null;
}

export interface QuoteMoneyState {
  state: OrderPaymentState;
  /** ₹ received so far. */
  received: number;
  /** ₹ still due (R-1707 open balance when loaded, else amount − received). */
  due: number;
}

export function quotePaymentState(q: QuoteMoneyFacts): QuoteMoneyState {
  const received = Math.max(0, Number(q.payment_amount ?? 0) || 0);
  const due = quoteBalanceDue({ amount: q.amount ?? 0, payment_amount: received, open_balance: q.open_balance });
  let state = orderPaymentState({ paymentStatus: q.payment_status, amount: q.amount, received });
  if (state === "part-paid" && due <= 0) state = q.payment_status === "partial" ? "part-paid" : "paid";
  return { state, received, due };
}

/** Invoiced, and only part of the money in — the case the stage word hid. */
export function invoicedPartPaid(q: QuoteMoneyFacts): boolean {
  return q.payment_status === "invoiced" && quotePaymentState(q).state === "part-paid";
}



/** "₹20,000 received · ₹18,232 still due" — both halves, never one alone (status-badge.ts cashNote). */
export function partPaidLine(m: Pick<QuoteMoneyState, "received" | "due">): string {
  return `${rupee(m.received)} received · ${rupee(m.due)} still due`;
}
