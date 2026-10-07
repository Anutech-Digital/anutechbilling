/**
 * Package pricing — what a package costs for N seats, today (2 Oct 2026).
 *
 * A package (table `packages`) is a recipe over catalogue rows; it has no price of its
 * own. Every number here is derived from the catalogue at the moment it is shown, so a
 * catalogue price change reaches every package without anyone re-saving one.
 *
 *  - per-seat parts are sized to the seat count; fixed parts are their fixed count
 *  - each part is priced at ITS OWN quantity (a volume band earned by 25 mail seats
 *    must not reprice one support plan), via slabPricing, or a yearly total verbatim
 *  - the package discount comes off each line's rate, rounded to whole rupees, and the
 *    catalogue rate is kept as list_rate — so the quote shows it as the customer's
 *    discount, the same way a hand-lowered rate already does
 *  - a part whose catalogue row is gone or inactive is reported as MISSING, never
 *    silently dropped: a package that adds two of its three parts looks finished
 *    and under-sells by one line
 */
import { slabPricing } from "@/lib/quotes/volume-tiers";
import { catalogYearlyPrice } from "@/lib/quotes/catalog-line";
import type { Item, QuoteLineItem } from "@/lib/supabase/database.types";

export interface PackageItemRow {
  item_id: string;
  qty_mode: "per_seat" | "fixed" | string;
  fixed_qty: number | null;
  optional: boolean;
  sort_order: number;
}

export interface PackageRow {
  id: string;
  name: string;
  pitch: string | null;
  discount_pct: number;
  is_active: boolean;
  sort_order: number;
  items: PackageItemRow[];
}

export interface PricedPart {
  part: PackageItemRow;
  item: Item;
  qty: number;
  /** Catalogue ₹ per unit per year, before the package discount. */
  listRate: number;
  /** ₹ per unit per year, after the package discount. */
  rate: number;
  /** Vendor cost ₹ per unit per year. */
  cost: number;
  /** rate × qty. */
  amount: number;
}

export interface PricedPackage {
  pkg: PackageRow;
  parts: PricedPart[];
  missing: PackageItemRow[];
  /** Every required part found. Optional misses do not block. */
  complete: boolean;
  listTotal: number;
  total: number;
  saving: number;
  /** total − cost, over total. Null when nothing is priced. */
  marginPct: number | null;
}

type PriceableItem = Pick<Item, "msrp" | "wholesale" | "prices">;

/** ₹ per unit per year for this item at this quantity. */
export function unitYearly(item: PriceableItem, qty: number): { rate: number; cost: number } {
  const yearly = catalogYearlyPrice(item);
  const hasSlabs = Array.isArray(item.prices?.slabs) && (item.prices?.slabs?.length ?? 0) > 0;
  if (!hasSlabs) return yearly;
  const s = slabPricing(item, qty);
  return { rate: Math.round(s.msrpPerSeatMonth * 12), cost: Math.round(s.wholesalePerSeatMonth * 12) };
}

export function partQty(part: PackageItemRow, seats: number): number {
  if (part.qty_mode === "fixed") return Math.max(1, part.fixed_qty ?? 1);
  return Math.max(1, Math.trunc(seats) || 1);
}

export function pricePackage(
  pkg: PackageRow,
  catalog: readonly Item[],
  seats: number,
  opts: { includeOptional?: boolean } = {},
): PricedPackage {
  const includeOptional = opts.includeOptional ?? true;
  const discount = Math.min(30, Math.max(0, Number(pkg.discount_pct) || 0));
  const parts: PricedPart[] = [];
  const missing: PackageItemRow[] = [];

  for (const part of [...pkg.items].sort((a, b) => a.sort_order - b.sort_order)) {
    const item = catalog.find((i) => i.id === part.item_id);
    if (!item || item.is_active === false) { missing.push(part); continue; }
    if (part.optional && !includeOptional) continue;
    const qty = partQty(part, seats);
    const { rate: listRate, cost } = unitYearly(item, qty);
    const rate = Math.round(listRate * (1 - discount / 100));
    parts.push({ part, item, qty, listRate, rate, cost, amount: rate * qty });
  }

  const listTotal = parts.reduce((s, p) => s + p.listRate * p.qty, 0);
  const total     = parts.reduce((s, p) => s + p.amount, 0);
  const costTotal = parts.reduce((s, p) => s + p.cost * p.qty, 0);
  const complete  = !missing.some((m) => !m.optional);
  return {
    pkg, parts, missing, complete, listTotal, total,
    saving: listTotal - total,
    marginPct: total > 0 ? Math.round(((total - costTotal) / total) * 100) : null,
  };
}

/** The quote lines a priced package adds. */
export function packageLines(p: PricedPackage, opts: { startDate?: string } = {}): QuoteLineItem[] {
  const stamp = Date.now();
  return p.parts.map((pp, i) => ({
    id: `line-${stamp}-${i}`,
    item_id: pp.item.id,
    name: pp.item.name,
    qty: pp.qty,
    rate: pp.rate,
    list_rate: pp.listRate,
    cost: pp.cost,
    commitment: "annual_yearly",
    ...(opts.startDate ? { start_date: opts.startDate } : {}),
  }));
}

/** "Support plan (Yearly) is no longer in the catalogue" — names the gap and the fix. */
export function missingMessage(p: PricedPackage, nameOf: (itemId: string) => string | undefined): string | null {
  if (p.missing.length === 0) return null;
  const names = p.missing.map((m) => nameOf(m.item_id) ?? m.item_id);
  return `${names.join(", ")} ${names.length === 1 ? "is" : "are"} no longer active in your catalogue — edit the package or turn the item back on under Products.`;
}
