import "server-only";
/**
 * The cart's coupon codes — SERVER ONLY (R-329, 7 Oct 2026).
 *
 * Until today this table sat in site/lib/money, which the cart page and the cart provider
 * import, so every code shipped in the public JS bundle even after R-225 took the names
 * off the page's HTML. The cart now asks POST /api/public/cart-coupon whether a typed code
 * is valid, and the checkout (lib/checkout/cart-checkout) prices it from here. A code is
 * percent off the FIRST payment, before GST, never on a domain line (R-225); renewals are
 * at list price (R-329, see cart-coupon.ts).
 */
export const COUPONS: Readonly<Record<string, number>> = {
  ANUTECH10: 0.10,
  MIGRATE15: 0.15,
};

/** The coupon's rate for a typed code (case and spaces forgiven); 0 for an unknown one. */
export function couponRate(code: string | undefined): number {
  const c = (code ?? "").trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(COUPONS, c) ? COUPONS[c] : 0;
}
