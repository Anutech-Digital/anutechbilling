/**
 * R-205 — Google Workspace list price floor: no screen shows Starter below ₹270/seat/month.
 *
 * 6 Oct 2026 (Pardeep): Starter is ₹3,240 a year = ₹270/seat/month, Standard ₹1,080, Plus
 * ₹1,380. The website pricing page and the app's quote chips were showing Starter at ₹136
 * (₹1,632/yr) — BELOW our own cost (₹3,080/yr), so every sale at that price is a loss. The
 * ₹136/₹736 figures are the old seed in lib/queries/items.ts (DEFAULT_CATALOG), which a
 * tenant's `items` rows were created from; checkout said ₹270 only because its name lookup
 * missed the "Business Starter" row and fell back to TIER_FALLBACK_MONTHLY.
 *
 * The fix for the DATA is a script the manager runs. This is the CODE guard: a GW Starter /
 * Standard / Plus price under the list price is a stale row, so it is lifted to the list
 * price (and logged once per name), never shown or quoted. A price ABOVE the list is kept —
 * a price rise in Operations → Catalog must still reach every screen.
 *
 * The list prices themselves live in ONE place, lib/pricing/workspace.ts
 * (TIER_FALLBACK_MONTHLY) — read from there, never copied. Whole rupees (§13).
 * Volume slabs (prices.slabs) are deliberate discounts and are left alone.
 */
import { TIER_FALLBACK_MONTHLY, type WorkspaceTierId } from "@/lib/pricing/workspace";

export type FlooredTier = Exclude<WorkspaceTierId, "enterprise">;

/** ₹/seat/month list price on annual commitment, per tier. */
export const WORKSPACE_LIST_PRICE_PM: Readonly<Record<FlooredTier, number>> = {
  starter:  TIER_FALLBACK_MONTHLY.starter,
  standard: TIER_FALLBACK_MONTHLY.standard,
  plus:     TIER_FALLBACK_MONTHLY.plus,
};

/**
 * Which GW tier a product name is, or null. Accepts the app's names ("Google Workspace
 * Business Starter", "Google Workspace Standard") and the website's ("GW Business Plus").
 * Enterprise has no list price; add-ons ("Plus + Voice add-on") are not Workspace names.
 */
export function workspaceTierOf(name: string | null | undefined): FlooredTier | null {
  const n = (name ?? "").toLowerCase();
  if (!/\b(google workspace|gw)\b/.test(n)) return null;
  if (/enterprise|add-?on|voice|archiv|vault|essentials/.test(n)) return null;
  if (/\bstarter\b/.test(n)) return "starter";
  if (/\bstandard\b/.test(n)) return "standard";
  if (/\bplus\b/.test(n)) return "plus";
  return null;
}

const warned = new Set<string>();

/** The ₹/seat/month to show or quote: `price`, lifted to the tier's list price if below it. */
export function floorWorkspacePrice(name: string | null | undefined, price: number): number {
  const tier = workspaceTierOf(name);
  if (!tier) return price;
  const floor = WORKSPACE_LIST_PRICE_PM[tier];
  if (Number.isFinite(price) && price >= floor) return price;
  const key = `${name}|${price}`;
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(`[R-205] stale Workspace price: "${name}" ₹${price}/seat/mo is below list ₹${floor} — using ₹${floor}. Fix the catalogue row.`);
  }
  return floor;
}

type Tier = { msrp?: number; wholesale?: number } | undefined;

/**
 * A catalogue row with its GW customer prices floored: `msrp`, `prices.annual.msrp` and
 * `prices.monthly.msrp`. Wholesale (cost) is never touched. Rows that are not GW
 * Starter/Standard/Plus, or already at/above list, come back as the SAME object.
 */
export function floorWorkspaceRow<T extends { name: string | null; msrp: number | null; prices?: unknown }>(row: T): T {
  if (!workspaceTierOf(row.name)) return row;
  const prices = (row.prices && typeof row.prices === "object" ? row.prices : null) as
    | ({ annual?: Tier; monthly?: Tier } & Record<string, unknown>)
    | null;
  const lift = (p: number | null | undefined): number | null | undefined =>
    typeof p === "number" && p > 0 ? floorWorkspacePrice(row.name, p) : p;

  const msrp = lift(row.msrp);
  const annual = prices?.annual ? { ...prices.annual, msrp: lift(prices.annual.msrp) ?? undefined } : undefined;
  const monthly = prices?.monthly ? { ...prices.monthly, msrp: lift(prices.monthly.msrp) ?? undefined } : undefined;

  const changed =
    msrp !== row.msrp ||
    (annual && annual.msrp !== prices?.annual?.msrp) ||
    (monthly && monthly.msrp !== prices?.monthly?.msrp);
  if (!changed) return row;

  const nextPrices = prices
    ? { ...prices, ...(annual ? { annual } : {}), ...(monthly ? { monthly } : {}) }
    : row.prices;
  return { ...row, msrp: msrp ?? row.msrp, prices: nextPrices };
}
