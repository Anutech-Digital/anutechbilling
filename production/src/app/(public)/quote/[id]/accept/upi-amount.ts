/**
 * What the UPI QR on the public accept page asks for (R-234).
 *
 * It must be the SAME money the Pay button charges. On a split-billed quote the
 * button (quote-accept-view.tsx `dueToday`) and the pay route (lib/checkout/quote-order.ts)
 * both collect instalment 1 — `quoteInstalments().firstGross` — and the rest is
 * invoiced period by period. The QR used to carry `quoteAmountDue` (the whole term),
 * so a quarterly customer saw "Pay this instalment · ₹7,080" above a QR for ₹28,320.
 *
 * This chooses between two EXISTING amounts; it computes neither:
 *  - `quoteAmountDue` still decides whether anything is collectable at all
 *    (₹ only, not settled, not invoiced) — 0 there means no QR.
 *  - `quoteInstalments`, called with the same arguments as the view's `dueToday`,
 *    gives instalment 1 when the quote is split.
 * A split quote at `partial` has had its first instalment paid; the pay route refuses
 * it, so the QR does too (0 = no QR) rather than ask for an instalment no invoice owns.
 */
import { quoteAmountDue, type QuoteBalanceFields } from "@/lib/payments/amount-due";
import { quoteInstalments } from "@/lib/billing/instalments";
import { cycleFromLegacyCommitment } from "@/lib/quotes/billing";
import type { BillingCycle } from "@/lib/supabase/database.types";

export interface QuoteUpiAmountFields extends QuoteBalanceFields {
  subtotal?: number | null;
  discount_pct?: number | null;
  tax_rate?: number | null;
  billing_cycle?: BillingCycle | null;
}

/** ₹ for the QR. 0 means "render no QR". */
export function quoteUpiAmount(q: QuoteUpiAmountFields, firstCommitment: string | null | undefined): number {
  const due = quoteAmountDue(q);
  if (due <= 0) return 0;

  const subtotal = q.subtotal ?? 0;
  const dueToday = quoteInstalments({
    cycle:          q.billing_cycle ?? cycleFromLegacyCommitment(firstCommitment),
    termTaxable:    subtotal - Math.round(subtotal * (q.discount_pct ?? 0) / 100),
    termGross:      q.amount ?? 0,
    taxRate:        q.tax_rate ?? 18,
    lineCommitment: firstCommitment ?? null,
  });
  if (!dueToday) return due;

  if ((q.payment_status ?? "").toLowerCase() === "partial") return 0;
  return dueToday.firstGross;
}
