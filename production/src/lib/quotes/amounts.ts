/**
 * Quote money helpers.
 *
 * grossAmount — the GST-inclusive payable from a taxable (ex-GST) subtotal,
 * using the same rounding the quote builder uses: subtotal + round(subtotal *
 * rate%). This is what the `quotes.amount` column must store (it's what the
 * customer pays and what record_payment treats as "expected").
 *
 * Renewal + extension quotes were storing the EX-GST subtotal in `amount`,
 * so they under-billed the 18% GST on every renewal (₹1,03,680 instead of
 * ₹1,22,342 for a 10-seat Standard renewal). This helper fixes that and keeps
 * renewal/extension consistent with normal quotes.
 */
export function grossAmount(subtotal: number, taxRatePct = 18): number {
  const base = Math.max(0, Math.round(subtotal));
  return base + Math.round((base * taxRatePct) / 100);
}

/**
 * How far a stored `quotes.amount` is from what its own subtotal and tax rate say it
 * should be. Positive = the quote is billing LESS than its tax rate implies.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Migration `20260817100000_fix_missing_gst_on_onboarded_quotes` never ran, and one
 * quote is still carrying its consequence: `Q-2026-9776` (BETA CO, accepted)
 * holds subtotal ₹45,360 at 18% with `amount` ₹45,360 — ₹8,165 of GST missing. Measured
 * 21 Aug 2026: across all 27 quotes in production it is the ONLY one off by more than a
 * rupee. So this check costs nothing on real work and catches exactly the broken row.
 *
 * The point is not to fix that quote. Whether ₹45,360 was meant to be GST-inclusive is a
 * commercial question, and answering it wrong either short-changes the company or
 * re-prices something a customer has already accepted. The point is that nobody should
 * be able to turn a self-inconsistent quote into a **tax invoice** by accident while
 * that question is open — an invoice is a GST document, and its numbers stop being
 * editable the moment it exists.
 */
export function quoteAmountGap(subtotal: number, taxRatePct: number, amount: number, discountPct = 0): number {
  return grossAmount(taxableAfterDiscount(subtotal, discountPct), taxRatePct) - Math.round(amount);
}

/**
 * The taxable value after a quote-level discount (coupon) — the same figure
 * `generate_invoice` puts on the tax invoice: subtotal − round(subtotal × pct / 100).
 * R-082 (1 Oct 2026): the consistency check ignored the discount, so every coupon quote
 * looked "wrong" (₹600 − 10% + 18% = ₹637 was compared with ₹708) and both the
 * customer's pay / retry link and staff "Generate invoice" refused it.
 */
export function taxableAfterDiscount(subtotal: number, discountPct = 0): number {
  const base = Math.round(subtotal);
  return base - Math.round((base * (discountPct || 0)) / 100);
}

/**
 * A rupee of slack, because `amount` and the recomputation can legitimately round in
 * different orders on older rows. Anything wider is a real disagreement, not rounding.
 */
export const QUOTE_AMOUNT_TOLERANCE = 1;

export function isQuoteAmountConsistent(subtotal: number, taxRatePct: number, amount: number, discountPct = 0): boolean {
  return Math.abs(quoteAmountGap(subtotal, taxRatePct, amount, discountPct)) <= QUOTE_AMOUNT_TOLERANCE;
}
