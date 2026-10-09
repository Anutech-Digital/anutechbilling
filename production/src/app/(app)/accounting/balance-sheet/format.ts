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

/**
 * S45 slice 2: opening-balance input → whole rupees. "" = CA ne ye aankda nahi diya (null);
 * paise, letters ya "1.5" = "bad" (AGENTS.md §1 — paisa poore rupees). Commas, spaces aur ₹
 * chalte hain ("5,00,000"); minus sirf aage ("-25000" = loss).
 */
export function parseWholeRupees(v: string): number | null | "bad" {
  const t = v.replace(/[,\s₹]/g, "");
  if (t === "") return null;
  return /^-?\d+$/.test(t) ? Number(t) : "bad";
}
