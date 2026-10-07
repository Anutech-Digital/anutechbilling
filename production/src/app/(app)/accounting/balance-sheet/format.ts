import { rupee } from "@/lib/utils";

/**
 * Balance Sheet money — Indian accounting notation: a negative is shown in parentheses,
 * e.g. (₹2,86,708), never with a minus sign.
 *
 * R-180 (6 Oct 2026): the same negative net worth read three ways on one page — "₹-57.5K" in
 * the tile, "(₹57,490)" in the table, "Net worth ₹-57,490" at the bottom. Every amount on the
 * Balance Sheet goes through this one function; `compact` keeps the tile short ("(₹57.5K)").
 */
export function fmtBS(amount: number, opts: { compact?: boolean } = {}): string {
  return amount < 0 ? `(${rupee(Math.abs(amount), opts)})` : rupee(amount, opts);
}
