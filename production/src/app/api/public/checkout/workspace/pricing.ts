/**
 * Pricing for POST /api/public/checkout/workspace — the Razorpay order amount comes from here.
 * Kept out of route.ts so it can be tested without a request, a DB or Razorpay.
 *
 * R-206: the catalogue row's ₹/seat/month goes through the R-205 floor before it becomes the
 * order amount, so a stale row (Starter ₹136, Standard ₹736) is charged at list (₹270 / ₹1,080 /
 * Plus ₹1,380) and logged. The floor is keyed on the tier the buyer picked, not the row's name.
 * A price above list is kept. Annual commitment = 12 months; +18% GST; whole rupees.
 */
import { WORKSPACE_LIST_PRICE_PM, floorWorkspacePrice } from "@/lib/catalog/workspace-floor";

export const TIER_DISPLAY_NAME: Record<string, string> = {
  starter:    "Business Starter",
  standard:   "Business Standard",
  plus:       "Business Plus",
  enterprise: "Enterprise",
};

export interface QuoteLine {
  id:          string;
  name:        string;
  qty:         number;
  rate:        number;
  cost:        number;
  commitment:  "annual_yearly";
}

export interface CatalogPriceRow {
  id:        string;
  name:      string;
  msrp:      number;
  wholesale: number | null;
  prices: {
    annual?:  { msrp: number; wholesale: number };
    monthly?: { msrp: number; wholesale: number };
  } | null;
}

function catalogMonthlyMsrp(row: CatalogPriceRow | null, tierId: string): number {
  if (row) {
    const annualMonthly = row.prices?.annual?.msrp;
    if (Number.isFinite(annualMonthly) && (annualMonthly ?? 0) > 0) return annualMonthly!;
    if (Number.isFinite(row.msrp) && row.msrp > 0) return row.msrp;
  }
  return (WORKSPACE_LIST_PRICE_PM as Record<string, number>)[tierId] ?? 0;
}

/** ₹/seat/month to charge: the catalogue price, never below the tier's list price. */
export function resolveMonthlyMsrp(row: CatalogPriceRow | null, tierId: string): number {
  const price = catalogMonthlyMsrp(row, tierId);
  const display = TIER_DISPLAY_NAME[tierId];
  if (!(tierId in WORKSPACE_LIST_PRICE_PM) || !display) return price;
  return floorWorkspacePrice(`Google Workspace ${display}`, price);
}

export function buildLinesFromCatalog(row: CatalogPriceRow | null, tierId: string, seats: number) {
  const monthly  = resolveMonthlyMsrp(row, tierId);
  const rate     = monthly * 12;
  const tierName = row?.name?.replace(/^Google Workspace\s*/i, "") || TIER_DISPLAY_NAME[tierId] || "Workspace";
  const items: QuoteLine[] = [{
    id: globalThis.crypto?.randomUUID() ?? Math.random().toString(36).slice(2),
    name: row?.name ?? `Google Workspace · ${tierName} (annual)`,
    qty: seats, rate, cost: 0, commitment: "annual_yearly",
  }];
  const subtotal = items.reduce((s, i) => s + i.qty * i.rate, 0);
  const amount   = Math.round(subtotal * 1.18);
  return { items, subtotal, amount, tierName, monthlyMsrp: monthly };
}
