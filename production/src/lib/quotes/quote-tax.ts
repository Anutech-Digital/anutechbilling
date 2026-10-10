/**
 * R-804 — the GST line a saved quote SHOWS, so subtotal + GST = total on every screen.
 *
 * Every quote screen worked the tax out on its own as `round(taxable × rate)` and printed
 * the stored `amount` as the total. For an add-seats quote those disagree by a rupee: the
 * server works in paise and rounds the subtotal and the total once each (R-803,
 * lib/subscriptions/seat-increase-charge.ts), so Q-F588-27-0006 is ₹853 + ₹153 = ₹1,006,
 * while the screens printed ₹853 + ₹154 under a ₹1,006 total.
 *
 * The rule is the server's own: GST shown = total − taxable value — the same split
 * generate_invoice freezes on the invoice (tax = gross − taxable). Display only; no stored
 * figure changes.
 *
 * Only a rounding gap (at most ₹1) is folded into the GST line. A larger gap means the
 * stored total itself does not match its lines, and hiding that inside "GST" would make a
 * wrong quote look right — so the separately worked-out tax is shown and the mismatch stays
 * visible.
 */

/** Largest gap between the stored total and taxable + round(taxable × rate) that is rounding. */
export const QUOTE_TAX_ROUNDING_TOLERANCE = 1;

/**
 * GST to print for a quote, in whole rupees.
 *
 * @param taxable  subtotal − discount, whole rupees
 * @param taxRate  percent (18, or 0 for a zero-rated export)
 * @param amount   the quote's stored total incl. GST, or null when it has none
 */
export function quoteDisplayTax(taxable: number, taxRate: number, amount: number | null | undefined): number {
  const worked = Math.round(taxable * (taxRate / 100));
  if (amount == null || !Number.isFinite(amount)) return worked;
  const fromTotal = amount - taxable;
  return Math.abs(fromTotal - worked) <= QUOTE_TAX_ROUNDING_TOLERANCE ? fromTotal : worked;
}
