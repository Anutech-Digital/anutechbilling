/**
 * R-377 — "Pay now ₹X" on the ACCEPTED confirmation of the public quote page.
 *
 * Flow test 7 Oct 2026: after accepting, the customer only read "{reseller} will
 * reach out with payment instructions" — no way to pay there and then, so the
 * money arrived days later. The page already has both pay paths (Razorpay via
 * /api/public/quote/[id]/pay and the UPI QR, R-234); this decides whether the
 * accepted screen offers them, and for how much.
 *
 * It computes NO new amount. The figure is the one `startQuotePayment`
 * (lib/checkout/quote-order.ts) charges: `quoteInstalments().firstGross` on a
 * split-billed quote, `quote.amount` otherwise — called with the same arguments.
 *
 * Null (= keep today's "will reach out" text) when:
 *  - the tenant has no payment method (no Razorpay keys AND no UPI QR) — the same
 *    `payOnline` / `upiQr` the review screen's pay buttons are gated on;
 *  - the quote is not in ₹ (Razorpay and UPI both settle rupees);
 *  - anything has been paid or invoiced already (invoice_id, received, invoiced,
 *    partial) — re-opening the link after paying must never ask again;
 *  - the amount is not positive.
 * The pay route re-checks every one of these; this only decides what is shown.
 */
import { quoteInstalments } from "@/lib/billing/instalments";
import { cycleFromLegacyCommitment } from "@/lib/quotes/billing";
import type { BillingCycle } from "@/lib/supabase/database.types";

export interface AcceptedPayQuote {
  amount: number | null;
  subtotal: number | null;
  discount_pct: number | null;
  tax_rate: number | null;
  billing_cycle?: BillingCycle | null;
  currency?: string | null;
  payment_status?: string | null;
  invoice_id?: string | null;
}

export interface AcceptedPay {
  /** ₹ collected today — firstGross on a split quote, the whole amount otherwise. */
  amount: number;
  /** Split-billed: "instalment 1 of N". Null for a single payment. */
  instalment: { count: number; cycle: BillingCycle } | null;
}

export function acceptedPayNow(input: {
  quote: AcceptedPayQuote;
  firstCommitment: string | null | undefined;
  /** Razorpay wired + ₹ quote (page.tsx `payOnline`). */
  payOnline: boolean;
  /** A UPI QR could be built (tenant has a valid VPA). */
  hasUpi: boolean;
}): AcceptedPay | null {
  const { quote, firstCommitment, payOnline, hasUpi } = input;
  if (!payOnline && !hasUpi) return null;

  const currency = (quote.currency ?? "INR").trim().toUpperCase();
  if (currency !== "INR") return null;

  if (quote.invoice_id) return null;
  const status = (quote.payment_status ?? "none").toLowerCase();
  if (status !== "none" && status !== "awaiting") return null;

  const subtotal = quote.subtotal ?? 0;
  const split = quoteInstalments({
    cycle:          quote.billing_cycle ?? cycleFromLegacyCommitment(firstCommitment),
    termTaxable:    subtotal - Math.round(subtotal * (quote.discount_pct ?? 0) / 100),
    termGross:      quote.amount ?? 0,
    taxRate:        quote.tax_rate ?? 18,
    lineCommitment: firstCommitment ?? null,
  });
  const amount = split ? split.firstGross : (quote.amount ?? 0);
  if (!(amount > 0)) return null;

  return { amount, instalment: split ? { count: split.count, cycle: split.cycle } : null };
}
