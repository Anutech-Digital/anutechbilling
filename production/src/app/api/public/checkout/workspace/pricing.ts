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
import { COMMIT_CHOICES, commitmentForChoice } from "@/lib/quotes/line-commit-choice";

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
  /** annual_yearly = 1-year plan (rate per user per YEAR); monthly = flex (rate per user per MONTH). */
  commitment:  "annual_yearly" | "monthly";
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

/* ── R-1967 (26 Oct 2026): Annual or Monthly (flex), chosen in the Buy now dialog ────────────
   The buyer picks one of the quote builder's own COMMIT_CHOICES ("annual" | "monthly"); the
   line carries commitmentForChoice() of it, so record_payment makes the subscription with the
   right term (annual_yearly → 12 months; monthly → 1 month, MRR not divided by 12 —
   supabase/tests/monthly_subscription.test.sql). The price is ALWAYS the server's: the
   catalogue row's flexible price (prices.monthly.msrp), never a rate from the browser.

   Monthly (flex) is one month: rate = ₹/user/month, qty = users, subtotal = users × rate, +18%
   GST — no × 12 anywhere (lib/pricing/workspace.ts "FLEX"). Like the page (buildTiers), a
   flexible price is only real when it is ABOVE the annual one; a lower one is a stale row and
   monthly is refused rather than sold below the annual plan. Annual is untouched
   (buildLinesFromCatalog). */

/** The two choices the website offers — values of the builder's COMMIT_CHOICES. */
export const BUY_COMMITMENTS = ["annual", "monthly"] as const satisfies readonly (typeof COMMIT_CHOICES)[number]["value"][];
export type BuyCommitment = (typeof BUY_COMMITMENTS)[number];

/**
 * Pardeep's monthly (flex) list price, ₹/user/month (decided 26 Oct 2026 on R-1967): used ONLY
 * when the catalogue has no row for the tier — the same figures the page's fallback tiers show.
 * Annual stays ₹270 / ₹1,080 (TIER_FALLBACK_MONTHLY).
 */
export const WORKSPACE_FLEX_LIST_PRICE_PM: Readonly<Record<string, number>> = {
  starter:  325,
  standard: 1300,
};

/** ₹/user/month on the monthly (flex) plan, or null when this tier is not sold monthly. */
export function resolveFlexMsrp(row: CatalogPriceRow | null, tierId: string): number | null {
  if (!row) return WORKSPACE_FLEX_LIST_PRICE_PM[tierId] ?? null;
  const flex = row.prices?.monthly?.msrp;
  if (typeof flex !== "number" || !Number.isFinite(flex) || flex <= 0) return null;
  return flex > resolveMonthlyMsrp(row, tierId) ? Math.round(flex) : null;
}

/** One month of the flexible plan for `seats` users, or null when monthly is not offered. */
export function buildFlexLinesFromCatalog(row: CatalogPriceRow | null, tierId: string, seats: number) {
  const rate = resolveFlexMsrp(row, tierId);
  if (rate === null) return null;
  const tierName = row?.name?.replace(/^Google Workspace\s*/i, "") || TIER_DISPLAY_NAME[tierId] || "Workspace";
  const items: QuoteLine[] = [{
    id: globalThis.crypto?.randomUUID() ?? Math.random().toString(36).slice(2),
    name: `${row?.name ?? `Google Workspace ${tierName}`} — monthly (flex)`,
    qty: seats, rate, cost: 0, commitment: commitmentForChoice("monthly") as "monthly",
  }];
  const subtotal = items.reduce((s, i) => s + i.qty * i.rate, 0);
  const amount   = Math.round(subtotal * 1.18);
  return { items, subtotal, amount, tierName, monthlyMsrp: rate };
}

/** The order lines for the buyer's choice — annual exactly as before; monthly, or null when not offered. */
export function buildOrderLines(row: CatalogPriceRow | null, tierId: string, seats: number, commitment: BuyCommitment) {
  return commitment === "monthly" ? buildFlexLinesFromCatalog(row, tierId, seats) : buildLinesFromCatalog(row, tierId, seats);
}
