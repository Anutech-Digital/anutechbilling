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
 *   awaiting / partly paid    → awaiting
 *   otherwise                 → its status (draft / sent / viewed / accepted)
 *
 * "Pipeline" = the quotes still open: draft, sent or viewed. Invoiced, rejected and replaced
 * quotes are not pipeline.
 */

export const QUOTE_LIST_TABS = [
  "draft", "sent", "viewed", "accepted", "awaiting", "invoiced", "rejected", "expired",
] as const;
export type QuoteListTab = (typeof QUOTE_LIST_TABS)[number];

export interface ListTabQuote {
  status: string;
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

export function quoteListTab(q: ListTabQuote): QuoteListTab {
  if (q.payment_status === "invoiced" || q.invoice_id) {
    return invoicedBalance(q) > 0 ? "awaiting" : "invoiced";
  }
  if (q.status === "rejected") return "rejected";
  if (q.status === "expired") return "expired";
  if (q.payment_status === "awaiting" || q.payment_status === "partial") return "awaiting";
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
export function isPipelineQuote(q: ListTabQuote): boolean {
  if (q.invoice_id || q.payment_status === "invoiced") return false;
  return q.status === "draft" || q.status === "sent" || q.status === "viewed";
}
