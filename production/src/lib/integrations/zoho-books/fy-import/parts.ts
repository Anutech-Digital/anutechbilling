/**
 * R-2499 — GENERIC FY import framework, part 3: an import goes to the database in parts (one batch
 * row + one activity_log row each), so no request runs past the function time limit. Part N is the
 * same documents on every call as long as the list is built in the scan's stable order
 * (doc date, then Zoho id) — a rerun of a part is harmless: the SQL counts what is there as "already".
 */

/** Documents per import part (each kind's SQL import takes at most 500). */
export const IMPORT_PART = 250;

export function partCount(n: number, size = IMPORT_PART): number {
  return Math.ceil(Math.max(0, n) / size);
}

/** Part `part` of `all`, or null when there is no such part. */
export function partOf<T>(all: readonly T[], part: unknown, size = IMPORT_PART): T[] | null {
  const p = Number(part);
  if (!Number.isInteger(p) || p < 0 || p >= partCount(all.length, size)) return null;
  return all.slice(p * size, (p + 1) * size);
}
