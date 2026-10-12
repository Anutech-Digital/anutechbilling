/**
 * Whole-rupee amounts typed into the personal vault forms (R-1419).
 *
 * The columns are `bigint` whole rupees. Any JS number at or above 1e21 is written by
 * JSON.stringify as "1e+21", and Postgres refuses that for bigint ("invalid input
 * syntax for type bigint") — which is what Pawan hit on staging by typing a very long
 * number. Numbers past 2^53 also stop being exact. So the form caps the amount at a
 * figure no personal holding can reach and says so in plain words, and the value it
 * returns is always a safe integer that serialises as plain digits.
 */

/** ₹1 lakh crore. Far above any personal holding, far below where numbers go inexact. */
export const MAX_RUPEES = 1_00_000_00_00_000; // 1e12

export type RupeeParse =
  | { ok: true; value: number }
  | { ok: false; reason: "not_a_number" | "too_big" };

export function parseRupees(input: string): RupeeParse {
  const cleaned = input.replace(/[,\s₹]/g, "");
  if (cleaned === "") return { ok: true, value: 0 };
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return { ok: false, reason: "not_a_number" };
  const n = Math.round(Number(cleaned));
  if (!Number.isFinite(n) || n < 0) return { ok: false, reason: "not_a_number" };
  if (n > MAX_RUPEES) return { ok: false, reason: "too_big" };
  return { ok: true, value: n };
}

/** Units are numeric(20,4): at most 16 digits before the point. */
export const MAX_UNITS = 1e15;
