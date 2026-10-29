/**
 * R-2097 — how the item form stores a typed price (29 Oct 2026).
 *
 * The pricing matrix keeps every tier as ₹ per seat per MONTH (`prices.annual`, `prices.monthly`),
 * and the yearly rows show it × 12. A yearly figure typed in is divided by 12. That used to be
 * rounded to 2 decimals — ₹1,000 / yr → 83.33 — and the same 83.33 went into `items.msrp`, an
 * INTEGER column, so the save failed ("invalid input syntax for type integer: 83.33"). Had it
 * saved, 83.33 × 12 = ₹999.96, not the ₹1,000 that was typed.
 *
 *  - The tier keeps the UNROUNDED monthly figure. `x / 12 * 12 === x` for every rupee-and-paise
 *    price (tested to ₹50,000), so every reader that prices a year gets the typed price back.
 *  - `items.msrp` / `items.wholesale` stay what they are — whole ₹ per seat per month, a headline
 *    for lists and old readers — so they get whole rupees. Readers that price a YEAR read the tier.
 */
import type { TierValue } from "./agent-sellable";

/** The ₹/seat/month a tier stores for a figure typed in a monthly ("mo") or yearly ("yr") box. */
export function storedFromTyped(raw: number, unit: "mo" | "yr"): number {
  const n = Number.isFinite(raw) && raw > 0 ? raw : 0;
  return unit === "yr" ? n / 12 : n;
}

/** The integer headline columns (`items.msrp`, `items.wholesale`) for the headline tier. */
export function headlineColumns(t: TierValue): { msrp: number; wholesale: number } {
  return { msrp: Math.round(t.msrp || 0), wholesale: Math.round(t.wholesale || 0) };
}
