/**
 * What a hosting plan costs — the ONE place the figure is computed.
 *
 * Checkout charges a hosting line by `hostingRate` (lib/checkout/cart-checkout.ts), and
 * `GET /api/public/hosting-prices` publishes `hostingPriceTable()` so the DMS panel shows
 * exactly what will be charged instead of keeping its own copy (owner, 28 Sep 2026: "Read
 * prices live from ResellerOS"). The inputs are LANDING_PLANS via HOSTING_TIERS
 * (site/lib/data/hosting-landing-v2.ts). Whole rupees throughout (AGENTS.md §1).
 *
 * GST: checkout applies 18% to the order's subtotal, once (`Math.round(subtotal × 1.18)`), so
 * for an order of one hosting line `inclGst` here is exactly what is paid.
 */
import { HOSTING_TIERS, type HostingTier } from "@/site/lib/data/hosting-landing-v2";

export const HOSTING_GST_RATE = 0.18;

export type HostingTierId = "starter" | "standard" | "plus";

export interface HostingCyclePrice {
  /** Months the charge covers. */
  months: 12 | 1;
  /** Taxable value, whole rupees — the quote line's rate. */
  exGst: number;
  /** What is paid for this line alone, whole rupees. */
  inclGst: number;
}

export interface HostingPlanPrice {
  id: HostingTierId;
  name: string;
  /** ₹/month when billed yearly — the headline figure on the plan cards. */
  perMonthYearly: number;
  yearly: HostingCyclePrice;
  monthly: HostingCyclePrice;
}

/** The ex-GST rate checkout puts on a hosting line, or null for an unknown tier. */
export function hostingRate(tier: string, yearly: boolean): number | null {
  return hostingRateIn(HOSTING_TIERS, tier, yearly);
}

/**
 * The same rule over a given tier list. R-1786: with CATALOG_FROM_DB on, the tiers come from
 * the price book (lib/catalog/catalog-prices.ts), whose prices are the `items` rows.
 */
export function hostingRateIn(tiers: readonly HostingTier[], tier: string, yearly: boolean): number | null {
  const t = tiers.find((x) => x.name.toLowerCase() === tier.toLowerCase());
  if (!t) return null;
  // Whole rupees — the money spine stores integers (CLAUDE.md §13); a fractional
  // tier total like ₹599.88 would break the integer lead/quote columns.
  return Math.round(yearly ? t.yearlyTotal : t.monthly);
}

const withGst = (exGst: number) => Math.round(exGst * (1 + HOSTING_GST_RATE));

/**
 * Every plan's price for both cycles, computed by the same rule checkout charges with.
 * `tiers` defaults to the code tiers; R-1786 passes the price book's tiers.
 */
export function hostingPriceTable(tiers: readonly HostingTier[] = HOSTING_TIERS): HostingPlanPrice[] {
  return tiers.map((t) => {
    const id = t.name.toLowerCase() as HostingTierId;
    const yearly = hostingRateIn(tiers, id, true) as number;
    const monthly = hostingRateIn(tiers, id, false) as number;
    return {
      id,
      name: t.name,
      perMonthYearly: t.yearlyMo,
      yearly: { months: 12, exGst: yearly, inclGst: withGst(yearly) },
      monthly: { months: 1, exGst: monthly, inclGst: withGst(monthly) },
    };
  });
}
