/**
 * Is this quote PDF still an offer, or a receipt for money already taken?
 *
 * R-034 (Pawan, 29 Sep 2026). A customer who pays from the DMS panel gets the
 * quote PDF back as their bill, and it still read "QUOTATION", "Valid until
 * <date>" and "Payment terms: Net 7 days from acceptance" — on an order that was
 * paid minutes earlier (seen on Q-2222-2026-27-0020, ₹708 paid). Three separate
 * sentences all telling a paying customer they still owe the money.
 *
 * The decision lives here rather than inside QuotePDF for the reason the PDF's own
 * `upiQrDataUrl` comment gives: the renderer cannot see payment state, and two
 * copies of "is it paid" is how the header and the footer end up disagreeing.
 * One function, one answer, asserted by a test.
 */
import type { Quote } from "@/lib/supabase/database.types";
import { isSupportUpgradeQuote } from "@/lib/support/upgrade-quote";

/**
 * Is the money IN, so nothing is owed on this document?
 *
 * `received` — yes. `partial` — no: part of the balance is genuinely still due, so the
 * validity window and the payment terms are still the truth for it.
 *
 * `invoiced` — ONLY when the payments recorded cover the quote. R-159 (5 Oct 2026, Hitesh,
 * Demo Co): "I converted a Quote into Invoice without payment. Why is it showing
 * quote paid?" generate_invoice sets payment_status = 'invoiced' whether or not money came
 * (invoicing before payment is allowed — "Invoice now (before payment)"), and this function
 * read 'invoiced' as settled, so an unpaid quote showed a ticked "Paid" step and downloaded
 * as "Paid order" without its payment terms. `payment_amount` is what record_payment writes
 * as the total received; generate_invoice never touches it. ₹1 of rounding is tolerated.
 */
export function quoteIsPaid(q: Pick<Quote, "payment_status"> & Partial<Pick<Quote, "payment_amount" | "amount">>): boolean {
  if (q.payment_status === "received") return true;
  if (q.payment_status !== "invoiced") return false;
  const total = Number(q.amount ?? 0);
  const received = Number(q.payment_amount ?? 0);
  return total > 0 && received >= total - 1;
}

/**
 * The word at the top of the document, and in its PDF metadata.
 *
 * "Paid order" and not "Invoice": this is not a GST tax invoice and must never be
 * mistaken for one — that document comes from `generate_invoice` with its own
 * gapless number (§17a). Naming it "Invoice" here would put a second, unnumbered
 * invoice-shaped paper in the customer's hands.
 */
export function quoteDocumentLabel(args: { paid: boolean; isRenewal?: boolean; isUpgrade?: boolean }): string {
  /* R-2087: a support-plan upgrade is stored as a renewal but renews nothing. */
  if (args.isUpgrade) return args.paid ? "Upgrade order · Paid" : "Upgrade Quotation";
  if (args.paid) return args.isRenewal ? "Renewal order · Paid" : "Paid order";
  return args.isRenewal ? "Renewal Quotation" : "Quotation";
}

/**
 * R-2093 — WHAT this quote is, decided once for every customer-facing document.
 *
 * R-2087 taught the server PDF (build-props) that a support-plan upgrade is stored with
 * is_renewal = true but renews nothing — yet the email PDF, the WhatsApp PDF, the attachment
 * builder and the /quote/[id]/accept page each passed their own `isRenewal: quote.is_renewal`,
 * so the customer still got "Renewal Quotation". Every renderer now asks this one function
 * (isSupportUpgradeQuote first) instead of reading the flag itself.
 */
export type QuoteDocumentKind = "quote" | "renewal" | "upgrade";

export type QuoteKindFacts = Parameters<typeof isSupportUpgradeQuote>[0];

export function quoteDocumentKind(q: QuoteKindFacts): QuoteDocumentKind {
  if (isSupportUpgradeQuote(q)) return "upgrade";
  return q.is_renewal === true ? "renewal" : "quote";
}

/** The two flags QuotePDF and RecordPaymentDialog take — spread them: `...flagsForQuoteKind(kind)`. */
export function flagsForQuoteKind(kind: QuoteDocumentKind): { isRenewal: boolean; isUpgrade: boolean } {
  return { isRenewal: kind !== "quote", isUpgrade: kind === "upgrade" };
}

/** Shorthand for a caller holding the quote row: `...quoteKindFlags(quote)` / `{...quoteKindFlags(quote)}`. */
export function quoteKindFlags(q: QuoteKindFacts): { isRenewal: boolean; isUpgrade: boolean } {
  return flagsForQuoteKind(quoteDocumentKind(q));
}
