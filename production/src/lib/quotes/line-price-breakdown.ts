/**
 * R-495 (Pardeep, 9 Oct 2026 — decision 1A): every quote line shows the customer what
 * they save — list price, discount (₹ and %) and the final rate — on the PDF, the
 * in-app preview and the customer's quote link. One builder, so the three never disagree.
 *
 * Where the list price comes from: `line.list_rate`, the catalogue / first-entered rate
 * frozen when the line was added (database.types.ts QuoteLineItem). It is NEVER invented:
 *   - no `list_rate` on the line (older quotes, hand-built props) → null, show only final;
 *   - `rate` is not below it (no discount, or a mark-up) → null, show only final.
 *
 * `toUnit` converts a stored figure into what the surface prints in its Rate column
 * (display currency, per-invoice slice) — list and final go through the SAME conversion,
 * so "List − Discount = Final" holds on every surface. The % is taken from the stored
 * figures, so rounding in the display unit never moves it.
 *
 * Totals are untouched: `rate` was always the figure the amount is built from.
 */

export interface LinePriceBreakdown {
  /** List price per unit, in the surface's display unit. */
  list: number;
  /** list − final, in the same unit. */
  discount: number;
  /** Discount as a % of list, 1 decimal (12.5), never shown as 0 for a real discount. */
  pct: number;
  /** The rate actually charged, in the same unit — what the Rate column shows. */
  final: number;
}

export interface PricedLine {
  rate: number;
  list_rate?: number | null;
}

export function linePriceBreakdown(
  line: PricedLine,
  toUnit: (stored: number) => number = (n) => n,
): LinePriceBreakdown | null {
  const listStored = line.list_rate;
  if (typeof listStored !== "number" || !Number.isFinite(listStored) || listStored <= 0) return null;
  if (!Number.isFinite(line.rate) || line.rate < 0 || line.rate >= listStored) return null;

  const list = toUnit(listStored);
  const final = toUnit(line.rate);
  // Cents-safe for a foreign display; whole rupees stay whole.
  const discount = Math.round((list - final) * 100) / 100;
  if (discount <= 0) return null;

  const rawPct = ((listStored - line.rate) / listStored) * 100;
  const pct = Math.max(0.1, Math.round(rawPct * 10) / 10);
  return { list, discount, pct, final };
}

/** "12.5" / "10" — no trailing ".0". */
export function formatDiscountPct(pct: number): string {
  return Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
}

/** One line of text for the surfaces that print it under the item name. */
export function linePriceBreakdownText(b: LinePriceBreakdown, fmt: (n: number) => string): string {
  return `List ${fmt(b.list)} · Discount ${fmt(b.discount)} (${formatDiscountPct(b.pct)}%) · Final ${fmt(b.final)}`;
}
