/**
 * /quotes ?focus= — the exact set behind each money tile (R-118, 2 Oct 2026).
 *
 * The tiles are summed WITH these predicates and the list filters by them, so the number on
 * a tile and the rows it opens cannot disagree. Before this, "Out for review" (sent + viewed)
 * opened the Sent tab only, and "Accepted" (every accepted quote) opened a tab that leaves
 * out the ones already invoiced.
 */
import { isPipelineQuote, quoteListTab } from "./list-tab";
import { invoicedPartPaid } from "./quote-payment-state";
import { QUOTE_STATE_LABEL, QUOTE_WITH_CUSTOMER_LABEL } from "./state-labels";

/** Paid in full, GST invoice not raised yet. R-1541: the Payments Received sidebar badge counts
 *  these quotes (nav_badges().payments) and opens ?focus=to-invoice. */
export const QUOTE_TO_INVOICE_PAYMENT_STATUS = "received";

export const QUOTE_FOCI = ["", "pipeline", "review", "accepted", "partial", "to-invoice"] as const;
export type QuoteFocus = (typeof QUOTE_FOCI)[number];

/* R-1713: state words from the one label map (state-labels.ts). */
export const QUOTE_FOCUS_LABEL: Record<Exclude<QuoteFocus, "">, string> = {
  /* R-469: the Pipeline tile — open quotes only, not invoiced/rejected/replaced ones. */
  pipeline: "Pipeline — draft, sent or viewed, not yet won",
  review: `${QUOTE_WITH_CUSTOMER_LABEL} — waiting on the customer`,
  accepted: `${QUOTE_STATE_LABEL.accepted} — not yet invoiced or awaiting payment`,
  partial: `${QUOTE_STATE_LABEL.partial} — some money in, balance still due`,
  "to-invoice": `${QUOTE_STATE_LABEL.received}, GST invoice not raised yet`,
};

/* partial / to-invoice are the /payments tiles "Partial Quotes" and "Awaiting GST Invoice":
   quotes by payment_status, which no quotes tab isolates (Awaiting payment is wider). */
export function quoteInFocus(q: { status: string; payment_status?: string | null; invoice_id?: string | null; amount?: number | null; payment_amount?: number | null; open_balance?: number | null }, focus: QuoteFocus): boolean {
  if (focus === "") return true;
  if (focus === "pipeline") return isPipelineQuote(q);
  /* R-489: the SAME bucket as the Sent + Viewed tabs. Was status sent/viewed alone, so a
     sent quote already part-paid or invoiced (it lives in Awaiting payment) made the header
     say "Out for review ₹73.3K (2)" over two empty tabs. */
  if (focus === "review") { const tab = quoteListTab(q); return tab === "sent" || tab === "viewed"; }
  /* R-1710: part-paid by MONEY — also once invoiced ('invoiced' alone said nothing about it). */
  if (focus === "partial") return q.payment_status === "partial" || invoicedPartPaid(q);
  if (focus === "to-invoice") return q.payment_status === QUOTE_TO_INVOICE_PAYMENT_STATUS;
  /* R-1713: the SAME set as the Accepted tab. "Accepted ₹6.2L (18)" counted every accepted
     quote while the tab it opened held 3 (the rest live in Awaiting payment / Invoiced). */
  return quoteListTab(q) === "accepted";
}

/** Sum of amount over the quotes in a focus — what the tile shows. */
export function focusValue(quotes: readonly { status: string; amount?: number | null; payment_status?: string | null; invoice_id?: string | null; payment_amount?: number | null }[], focus: QuoteFocus): number {
  return quotes.filter((q) => quoteInFocus(q, focus)).reduce((s, q) => s + (q.amount ?? 0), 0);
}
