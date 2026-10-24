/**
 * R-1739 — where a payment was recorded.
 *
 * Every payment is keyed by its quote, except a payment against an invoice imported from
 * Zoho Books (document_kind 'opening_invoice'): that invoice has no quote, so the payment
 * carries the invoice instead (payments.quote_id NULL, payments.invoice_id set). Screens
 * that link a payment to "its quote" use these two helpers so such a payment opens its
 * invoice rather than /quotes/null.
 */
export interface PaymentSource {
  quote_id: string | null;
  invoice_id?: string | null;
}

/** The document number the payment was recorded on: the quote, else the imported invoice. */
export function paymentDocId(p: PaymentSource): string {
  return p.quote_id ?? p.invoice_id ?? "";
}

/** The page of that document. */
export function paymentDocHref(p: PaymentSource): string {
  if (p.quote_id) return `/quotes/${p.quote_id}`;
  if (p.invoice_id) return `/invoices/${encodeURIComponent(p.invoice_id)}`;
  return "/payments";
}
