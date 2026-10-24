/**
 * Which ONE tab a quote belongs to on /quotes (R-482 / board R-469, 9 Oct 2026).
 *
 * Abhishek's Scenario 15: the tabs added up to 11 for 10 quotes — an invoiced quote with a
 * balance sat in both "Accepted"/"Invoiced" and "Awaiting payment", and a REJECTED quote was
 * shown under "Expired" because there was no Rejected tab. Tab counts that do not add up to
 * "All" make every count look wrong, so each quote now has exactly one home:
 *
 *   invoiced, balance due     → awaiting   (the money is still to collect)
 *   invoiced, fully paid      → invoiced
 *   rejected                  → rejected
 *   expired / replaced        → expired
 *   accepted + awaiting, or partly paid → awaiting  (R-1713: a sent quote stays Sent)
 *   otherwise                 → its status (draft / sent / viewed / accepted)
 *
 * "Pipeline" = the quotes still open: draft, sent or viewed. Invoiced, rejected and replaced
 * quotes are not pipeline.
 */

import { istToday } from "@/lib/dates/ist";
import { shownQuoteStatus, expiredByDate } from "./quote-expiry";

export const QUOTE_LIST_TABS = [
  "draft", "sent", "viewed", "accepted", "awaiting", "invoiced", "rejected", "expired",
] as const;
export type QuoteListTab = (typeof QUOTE_LIST_TABS)[number];

export interface ListTabQuote {
  status: string;
  /** R-1679: the validity date — a waiting quote past it shows as expired (quote-expiry.ts). */
  expires_date?: string | null;
  payment_status?: string | null;
  invoice_id?: string | null;
  amount?: number | null;
  payment_amount?: number | null;
  /** R-1707: quote_open_balance() for this quote (lib/quotes/open-balances.ts). null/absent =
   *  not loaded → the old amount − payment_amount, never 0. */
  open_balance?: number | null;
}

/**
 * Balance still to collect on a quote (₹, never negative).
 * R-1707: the database's quote_open_balance when the list has it — it counts credit notes,
 * refunds and what the invoice itself still says is payable. amount − payment_amount did not:
 * a refunded, credit-noted #0020 showed "₹38,232 due" and sat in Awaiting payment.
 */
export function quoteBalanceDue(q: Pick<ListTabQuote, "amount" | "payment_amount" | "open_balance">): number {
  if (typeof q.open_balance === "number") return Math.max(0, q.open_balance);
  return Math.max(0, (q.amount ?? 0) - (q.payment_amount ?? 0));
}

function invoicedBalance(q: ListTabQuote): number {
  return quoteBalanceDue(q);
}

export function quoteListTab(q: ListTabQuote, today: string = istToday()): QuoteListTab {
  if (q.payment_status === "invoiced" || q.invoice_id) {
    return invoicedBalance(q) > 0 ? "awaiting" : "invoiced";
  }
  if (q.status === "rejected") return "rejected";
  /* R-1679: a sent / viewed quote whose validity ended is Expired, not Sent (quote-expiry.ts). */
  if (shownQuoteStatus(q, today) === "expired") return "expired";
  /* R-1713: 'awaiting' counts only once the customer ACCEPTED. Extension, add-seats and
     checkout quotes are created with payment_status 'awaiting', so a sent one landed in
     "Awaiting payment" with its badge saying it was sent and the Sent tab at 0. */
  if (q.payment_status === "partial" || (q.payment_status === "awaiting" && q.status === "accepted")) return "awaiting";
  if (q.status === "draft" || q.status === "sent" || q.status === "viewed" || q.status === "accepted") {
    return q.status;
  }
  return "expired";
}

/** Count per tab plus `all`. The tab counts always add up to `all`. */
export function quoteTabCounts(quotes: readonly ListTabQuote[]): Record<QuoteListTab | "all", number> {
  const counts = Object.fromEntries(QUOTE_LIST_TABS.map((t) => [t, 0])) as Record<QuoteListTab, number>;
  for (const q of quotes) counts[quoteListTab(q)] += 1;
  return { all: quotes.length, ...counts };
}

/** Still open with the customer — what "Pipeline" adds up. */
export function isPipelineQuote(q: ListTabQuote, today: string = istToday()): boolean {
  if (q.invoice_id || q.payment_status === "invoiced") return false;
  /* R-1679: an offer whose validity ended is no longer open with the customer. */
  if (expiredByDate(q, today)) return false;
  return q.status === "draft" || q.status === "sent" || q.status === "viewed";
}
