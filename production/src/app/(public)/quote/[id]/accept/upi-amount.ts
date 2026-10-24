/**
 * What the UPI QR on the public accept page asks for (R-234, R-1613).
 *
 * It must be the SAME money the Pay button charges. Both now come from `quoteDueNow`
 * (lib/payments/quote-due-now.ts), the function the pay route (lib/checkout/quote-order.ts)
 * charges from: instalment 1 on a split-billed quote, otherwise quote total − money already
 * received. Before R-1613 the QR read `quoteAmountDue` (total − the quote's payment_amount
 * label) and the page's Pay button the whole total, while the order charged the remainder.
 *
 * 0 means "render no QR": a foreign quote (UPI settles rupees only), a paid or invoiced
 * quote, or a split quote whose first instalment is paid (the rest is invoiced).
 */
import { quoteDueNowUpiAmount, type QuoteDueNow } from "@/lib/payments/quote-due-now";

/** ₹ for the QR. 0 means "render no QR". */
export function quoteUpiAmount(due: QuoteDueNow): number {
  return quoteDueNowUpiAmount(due);
}
