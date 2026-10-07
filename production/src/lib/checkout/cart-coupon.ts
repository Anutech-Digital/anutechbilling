/**
 * The cart checkout's coupon (R-225, 7 Oct 2026) — the same rule the cart page shows
 * (couponSplit in site/lib/money), applied to the server-priced quote lines.
 *
 * Pardeep: keep the coupons, but never on a domain line (a domain sells close to the
 * registry's cost). Every other line is discounted exactly as before:
 *
 *  - no priced domain line → quote-level `discount_pct` off the gross, unchanged since
 *    24 Sep 2026; `generate_invoice` prints it as the invoice's Discount row.
 *  - domain-only cart → nothing off.
 *  - priced domain + other lines → `discount_pct` cannot do it (a whole-number % of the
 *    WHOLE subtotal, smallint), so the discount comes off each other line's rate, whole
 *    rupees, with the catalogue rate kept as `list_rate` — the package pattern
 *    (lib/packages/price.ts). The quote's subtotal is then already the taxable value.
 *
 * Mutates the discounted lines' `rate` / `list_rate` in place (the caller's quote lines).
 */
import { couponRate, couponSplit, discountedUnitPrice } from "@/site/lib/money";

export interface CouponQuoteLine { qty: number; rate: number; list_rate?: number }

export interface CartCouponResult {
  /** The typed code, normalised. */
  couponCode: string;
  /** Whether anything came off. */
  applied: boolean;
  /** The coupon's percent, for the order notes ("Coupon X: 10% off"). 0 when not applied. */
  ratePct: number;
  /** Σ qty × rate BEFORE the coupon. */
  gross: number;
  /** What `quotes.subtotal` stores: Σ qty × rate of the lines as saved. */
  quoteSubtotal: number;
  /** What `quotes.discount_pct` stores. */
  discountPct: number;
  /** Taxable value in whole rupees — GST is charged on this. */
  subtotal: number;
  /** gross − subtotal. */
  discount: number;
}

export function applyCartCoupon<T extends CouponQuoteLine>(
  items: T[],
  isExempt: (line: T) => boolean,
  code: string | undefined,
): CartCouponResult {
  const couponCode = (code ?? "").trim().toUpperCase();
  const rate = couponRate(couponCode);
  const gross = items.reduce((s, i) => s + i.qty * i.rate, 0);
  const { mode } = couponSplit(items.map((i) => ({ qty: i.qty, price: i.rate, exempt: isExempt(i) })), rate);

  if (mode === "whole") {
    // Whole rupees, like every other money column (CLAUDE.md §13).
    const subtotal = Math.round(gross * (1 - rate));
    return { couponCode, applied: true, ratePct: Math.round(rate * 100), gross, quoteSubtotal: gross, discountPct: Math.round(rate * 100), subtotal, discount: gross - subtotal };
  }

  if (mode === "lines") {
    for (const line of items) {
      if (isExempt(line)) continue;
      line.list_rate = line.rate;
      line.rate = discountedUnitPrice(line.rate, rate);
    }
    const subtotal = Math.round(items.reduce((s, i) => s + i.qty * i.rate, 0));
    return { couponCode, applied: true, ratePct: Math.round(rate * 100), gross, quoteSubtotal: subtotal, discountPct: 0, subtotal, discount: gross - subtotal };
  }

  const subtotal = Math.round(gross);
  return { couponCode, applied: false, ratePct: 0, gross, quoteSubtotal: gross, discountPct: 0, subtotal, discount: 0 };
}
