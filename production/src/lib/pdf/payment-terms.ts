/**
 * R-1670 (3) — what a quote says about when the invoice is due.
 *
 * The quote PDF printed "Net 7 days from acceptance" for every customer. The invoice raised
 * from the quote is due on invoice date + quotes.payment_terms_days, or + 30 when the quote
 * carries none (generate_invoice: `coalesce(v_quote.payment_terms_days, 30)`), so a Net 30
 * customer saw Net 7 on the quote and Net 30 on the invoice. Same rule here, one place.
 */
export const DEFAULT_INVOICE_TERMS_DAYS = 30;

export function quotePaymentTermsLine(days: number | null | undefined): string {
  const n = typeof days === "number" && Number.isFinite(days) && days >= 0 ? Math.round(days) : DEFAULT_INVOICE_TERMS_DAYS;
  if (n === 0) return "Due on receipt of the invoice.";
  return `Net ${n} day${n === 1 ? "" : "s"} from the invoice date.`;
}
