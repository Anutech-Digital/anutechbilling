/**
 * R-243 (6 Oct 2026): /quotes/<id>?pay=1 opens the Record-payment dialog straight away, the
 * same way ?send= opens the send dialogs. Any screen that says "Record payment" for a quote
 * can link here and the operator lands in the dialog, amount filled, instead of on the quote
 * hunting for a second button.
 *
 * The dialog only opens when the quote's own money rules (lib/quotes/money-stage.ts) offer a
 * Record-payment button — never on a draft, a closed quote, or one an invoice already owns.
 */
import { quoteMoneyActions } from "@/lib/quotes/money-stage";

export interface PayIntentQuote {
  status: string;
  payment_status: string | null;
  invoice_id: string | null;
  amount: number | null;
  subtotal: number;
  discount_pct: number;
  tax_rate: number;
}

/** The quote's total in ₹ — the stored amount, else subtotal − discount + GST (whole rupees). */
export function quoteTotal(q: Pick<PayIntentQuote, "amount" | "subtotal" | "discount_pct" | "tax_rate">): number {
  const discount = Math.round(q.subtotal * (q.discount_pct / 100));
  const taxable = q.subtotal - discount;
  const tax = Math.round(taxable * (q.tax_rate / 100));
  return q.amount ?? taxable + tax;
}

/**
 * What to do with ?pay=: "open" the dialog (and clean the URL), "drop" the param (asked for,
 * but this quote takes no payment), or "none" (no ?pay=1, or the data is still loading).
 */
export function payIntent(
  pay: string | null,
  quote: PayIntentQuote | null | undefined,
  received: number | null,
): "open" | "drop" | "none" {
  if (pay !== "1") return "none";
  if (!quote || received == null) return "none";      // wait for the quote and its payments
  const money = quoteMoneyActions(
    { status: quote.status, paymentStatus: quote.payment_status, invoiceId: quote.invoice_id, total: quoteTotal(quote), received },
    (n) => String(n),
  );
  return money.canRecordPayment ? "open" : "drop";
}
