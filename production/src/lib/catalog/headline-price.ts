/**
 * The price a catalogue row shows on /items (2 Oct 2026).
 *
 * Most rows are a per-seat monthly rate in `msrp`. A yearly-discount plan (the support
 * "(Yearly)" SKUs) keeps `msrp` at 0 and its whole-year total in `prices.annual_total`,
 * see lib/subscriptions/catalog-options.ts — so printing `msrp` showed "₹0/mo" for a
 * ₹9,996-a-year plan.
 *
 * R-526: the unit follows the row's billing unit (lib/catalog/billing-unit.ts) — a domain set
 * to "per year" shows /yr, a migration set to "one-time" shows "once". Print it with
 * `headlineSuffix`, which also says "/seat" when the price is per seat.
 */
import { billingUnitOf, storedPriceSuffix, type BillingUnitRow } from "@/lib/catalog/billing-unit";

export interface HeadlinePriceRow {
  msrp: number;
  prices?: unknown;
  vendor?: string | null;
  item_type?: string | null;
}

export function headlinePrice(it: HeadlinePriceRow): { amount: number; unit: "mo" | "yr" | "once" } {
  const total = (it.prices as { annual_total?: { msrp?: number } } | null | undefined)?.annual_total?.msrp;
  if (typeof total === "number" && total > 0 && !(it.msrp > 0)) return { amount: total, unit: "yr" };
  const unit = billingUnitOf(it);
  return { amount: it.msrp, unit: unit === "unit_year" ? "yr" : unit === "one_time" ? "once" : "mo" };
}

/** "/seat/mo", "/mo", "/yr" or " one-time" — the suffix for the headline amount. */
export function headlineSuffix(it: HeadlinePriceRow & BillingUnitRow): string {
  return storedPriceSuffix(billingUnitOf(it));
}

/** Support is our own service: no vendor cost, so a margin % on it means nothing. */
export function isOwnService(it: { vendor?: string | null }): boolean {
  return it.vendor === "support";
}
