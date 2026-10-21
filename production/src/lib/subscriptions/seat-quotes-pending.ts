/**
 * R-1705 (21 Oct 2026): open add-seats (pro-rata) quotes — money owed for seats that are
 * already live on a subscription.
 *
 * Manage seats adds the seats at once (kept on purpose: the customer is using them) and raises
 * a pro-rata quote. That quote's amount is NOT in subscriptions.outstanding_amount, so before
 * R-1705 it sat in no dues list (local audit, T-A1: Q-F588-27-0031 ₹3,813 "sent", subscription
 * owed ₹18,232 only). These helpers decide which seat quotes are still open and how much each
 * still asks for, so the subscription drawer and Payments → Subscription dues can show them.
 * Rejecting such a quote takes the seats back (DB trigger trg_quotes_add_seats_take_back).
 */
import { rupee } from "@/lib/utils";

export interface SeatQuoteRow {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  plan: string | null;
  seats: number | null;
  amount: number | null;
  payment_amount: number | null;
  status: string;
  payment_status: string | null;
  invoice_id: string | null;
  is_add_seats: boolean | null;
  superseded_by: string | null;
  add_seats_subscription_id: string | null;
  add_seats_taken_back_at: string | null;
  notes: string | null;
}

export interface OpenSeatQuote {
  quoteId: string;
  subscriptionId: string | null;
  customerId: string | null;
  customerName: string;
  plan: string;
  seats: number;
  /** What the quote still asks for (amount − money already received on it). */
  pending: number;
}

/** Columns the readers select. */
export const SEAT_QUOTE_COLS =
  "id, customer_id, customer_name, plan, seats, amount, payment_amount, status, payment_status, invoice_id, is_add_seats, superseded_by, add_seats_subscription_id, add_seats_taken_back_at, notes";

const SUB_IN_NOTES = /subscription ([0-9a-fA-F-]{36})/;

/** The subscription the seats were added to — the stored link, else the addSeats() note (pre-R-1705 quotes). */
export function seatQuoteSubscriptionId(q: Pick<SeatQuoteRow, "add_seats_subscription_id" | "notes">): string | null {
  return q.add_seats_subscription_id ?? q.notes?.match(SUB_IN_NOTES)?.[1] ?? null;
}

/** Still asking for money: sent / viewed / accepted, not replaced, not taken back, not invoiced, not fully paid. */
export function isOpenSeatQuote(q: SeatQuoteRow): boolean {
  if (!q.is_add_seats) return false;
  if (!["sent", "viewed", "accepted"].includes(q.status)) return false;
  if (q.superseded_by || q.add_seats_taken_back_at || q.invoice_id) return false;
  if (!["none", "awaiting", "partial", null].includes(q.payment_status)) return false;
  return seatQuotePendingAmount(q) > 0;
}

export function seatQuotePendingAmount(q: Pick<SeatQuoteRow, "amount" | "payment_amount">): number {
  return Math.max(0, (q.amount ?? 0) - (q.payment_amount ?? 0));
}

export function openSeatQuotes(rows: readonly SeatQuoteRow[]): OpenSeatQuote[] {
  return rows.filter(isOpenSeatQuote).map((q) => ({
    quoteId: q.id,
    subscriptionId: seatQuoteSubscriptionId(q),
    customerId: q.customer_id,
    customerName: q.customer_name ?? "",
    plan: q.plan ?? "",
    seats: q.seats ?? 0,
    pending: seatQuotePendingAmount(q),
  }));
}

/** One subscription's open seat quotes — keyed by the quote's own subscription link, never by customer. */
export function seatQuotesForSubscription(list: readonly OpenSeatQuote[], subscriptionId: string): OpenSeatQuote[] {
  return list.filter((q) => q.subscriptionId === subscriptionId);
}

export function seatQuotePendingText(q: Pick<OpenSeatQuote, "pending" | "seats">): string {
  return `Seat quote pending ${rupee(q.pending)} · +${q.seats} seat${q.seats === 1 ? "" : "s"}`;
}

/** "1 added seat" / "3 added seats" — for the quote page's reject wording. */
export function addSeatsCount(n: number | null | undefined): string {
  const k = n ?? 0;
  return `${k} added seat${k === 1 ? "" : "s"}`;
}
