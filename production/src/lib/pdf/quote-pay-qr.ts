/**
 * R-1694 — the ONE rule for "does this quote get a scan-to-pay UPI QR, and for how much".
 *
 * Used by the quote PDF route (api/v1/documents/quote/[id]/pdf) and by the staff preview
 * ("Preview · This is how the customer will see it", via api/quotes/[id]/pay-qr). Before this
 * the PDF printed a QR and the preview had no QR code at all, so the owner was told "this is
 * how the customer will see it" about a document that was missing its pay QR.
 *
 * Rule (unchanged from R-1613): the QR asks for exactly what the online Pay button charges —
 * `quoteDueNowUpiAmount(due)` from `readQuoteDueNow` (total − money received, instalment 1 on a
 * split quote). No QR when the tenant has no UPI ID, on a non-INR quote (UPI settles rupees
 * only), a paid quote, or one already invoiced. Never throws (buildQuoteUpiQr's contract).
 */
import { buildQuoteUpiQr, type UpiQr } from "@/lib/pdf/upi-qr";
import { quoteDueNowUpiAmount, type QuoteDueNow } from "@/lib/payments/quote-due-now";

export interface QuotePayQrTenant {
  name?: string | null;
  upi_vpa?: string | null;
  upi_payee_name?: string | null;
}

export interface QuotePayQr extends UpiQr {
  /** ₹ the QR asks for. */
  amount: number;
}

export async function quotePayQr(args: {
  tenant: QuotePayQrTenant | null | undefined;
  quoteId: string;
  /** From `readQuoteDueNow(client, quote)` — the same read the Razorpay order charges from. */
  due: QuoteDueNow;
}): Promise<QuotePayQr | null> {
  const amount = quoteDueNowUpiAmount(args.due);
  const qr = await buildQuoteUpiQr({
    vpa:       args.tenant?.upi_vpa,
    payeeName: args.tenant?.upi_payee_name ?? args.tenant?.name,
    quoteId:   args.quoteId,
    amountDue: amount,
  });
  return qr ? { ...qr, amount } : null;
}
