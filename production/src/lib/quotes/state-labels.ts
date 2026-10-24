/**
 * R-1713 (billing audit, 20 Oct 2026) — ONE name for each quote state.
 *
 * A quote that had been sent showed three names at once: the row badge said "Out for review",
 * it sat in the "Awaiting payment (21)" tab, and the "Sent (0)" tab and the "Out for review
 * ₹0 (0)" tile were empty. Every place that names a quote state — the /quotes tabs, the row
 * badge, the tiles, the ?focus= banner and the /quotes/<id> header — now reads its word from
 * this one map, so the same state cannot be called two things again.
 */

export const QUOTE_STATE_LABEL = {
  draft: "Draft",
  sent: "Sent",
  viewed: "Viewed",
  accepted: "Accepted",
  /** Accepted (or invoiced) and the money not in yet. */
  awaiting: "Awaiting payment",
  /** Some money in, some still due. */
  partial: "Partly paid",
  /** Paid in full, before the GST invoice. */
  received: "Paid",
  invoiced: "Invoiced",
  rejected: "Rejected",
  expired: "Expired",
  /** A revision took its place. */
  replaced: "Replaced",
} as const;

export type QuoteStateKey = keyof typeof QUOTE_STATE_LABEL;

/** The word for a state; an unknown key is shown as itself rather than as a wrong word. */
export function quoteStateLabel(state: string): string {
  return (QUOTE_STATE_LABEL as Record<string, string>)[state] ?? state;
}

/** The /quotes "still with the customer" tile and focus: exactly the Sent + Viewed tabs. */
export const QUOTE_WITH_CUSTOMER_LABEL = `${QUOTE_STATE_LABEL.sent} + ${QUOTE_STATE_LABEL.viewed.toLowerCase()}`;
