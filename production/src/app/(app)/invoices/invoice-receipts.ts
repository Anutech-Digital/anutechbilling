/**
 * R-1636 — whose receipts belong on an invoice's page.
 *
 * A quote-backed invoice: the receipts on its own quote (quotes.invoice_id = this invoice).
 * A subscription instalment (R-1564): invoices.quote_id is NULL on purpose, and its payment is
 * recorded on the SUBSCRIPTION's quote by record_instalment_payment, which applies it to this
 * instalment first and the rest to the next open ones. Looking only for the invoice's own quote
 * found nothing, so the page said "No payment receipts" after a payment and the TDS banner
 * never showed.
 */
import { invoiceAmountDue, type InvoiceBalanceFields } from "@/lib/payments/amount-due";

export type InvoiceReceiptsSource = { quoteId: string; instalment: boolean } | null;

/** The invoice's own quote, else (an instalment) its subscription's quote, else none. */
export function invoiceReceiptsQuote(
  ownQuoteId: string | null | undefined,
  instalment: { quoteId: string | null } | null | undefined,
): InvoiceReceiptsSource {
  if (ownQuoteId) return { quoteId: ownQuoteId, instalment: false };
  if (instalment?.quoteId) return { quoteId: instalment.quoteId, instalment: true };
  return null;
}

/**
 * The total and the received part the TDS banner (R-1520) compares. An own-quote invoice: the
 * quote's total and its receipts, as before. An instalment: THIS invoice's amount and what is
 * settled on it (amount − still due) — its subscription quote's receipts cover the whole year.
 */
export function invoiceTdsMoney(input: {
  invoice: InvoiceBalanceFields & { amount: number };
  source: InvoiceReceiptsSource;
  quoteTotal: number;
  quoteReceived: number;
}): { total: number; received: number } | null {
  const { invoice, source } = input;
  if (!source) return null;
  if (!source.instalment) return { total: input.quoteTotal, received: input.quoteReceived };
  const total = Math.round(invoice.amount);
  return { total, received: total - invoiceAmountDue(invoice) };
}
