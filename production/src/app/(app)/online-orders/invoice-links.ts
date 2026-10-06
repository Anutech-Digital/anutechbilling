/**
 * R-083 (6 Oct 2026) — "Online Orders mein har order ke saath uska invoice ka link."
 *
 * A paid website order gets its GST invoice automatically (R-079: the Razorpay webhook calls
 * `generate_invoice` on the order's quote). The invoice id lands on `quotes.invoice_id`, and
 * the quote points back at the order's lead via `quotes.lead_id`. Online Orders reads leads,
 * so it never saw the invoice: the drawer showed "Invoice —" and the Invoice button only
 * toasted "Downloading…".
 *
 * This module joins the two: for each lead, the invoice of its newest invoiced quote, and the
 * one URL every other screen already uses to open a single invoice (`/invoices?open=<id>`).
 */

export interface QuoteInvoiceRow {
  lead_id: string | null;
  invoice_id: string | null;
  created_at: string | null;
}

/**
 * lead id → invoice id. A lead with several invoiced quotes (a re-quote that was also paid)
 * gets the NEWEST one; quotes with no lead or no invoice are ignored.
 */
export function invoiceByLead(rows: readonly QuoteInvoiceRow[]): Map<string, string> {
  const newest = new Map<string, { invoiceId: string; at: string }>();
  for (const r of rows) {
    const leadId = r.lead_id?.trim();
    const invoiceId = r.invoice_id?.trim();
    if (!leadId || !invoiceId) continue;
    const at = r.created_at ?? "";
    const seen = newest.get(leadId);
    if (!seen || at > seen.at) newest.set(leadId, { invoiceId, at });
  }
  return new Map([...newest].map(([lead, v]) => [lead, v.invoiceId]));
}

/** The single-invoice URL the rest of the app uses (payments, quotes, command palette). */
export function invoiceHref(invoiceId: string): string {
  return `/invoices?open=${encodeURIComponent(invoiceId)}`;
}
