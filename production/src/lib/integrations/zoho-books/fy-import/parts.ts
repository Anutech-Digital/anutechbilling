/**
 * R-2499 — GENERIC FY import framework, part 3: an import goes to the database in parts (one batch
 * row + one activity_log row each), so no request runs past the function time limit. Part N is the
 * same documents on every call as long as the list is built in the scan's stable order
 * (doc date, then Zoho id) — a rerun of a part is harmless: the SQL counts what is there as "already".
 */

/** Documents per import part (each kind's SQL import takes at most 500). */
export const IMPORT_PART = 250;

/**
 * R-2547 — customer payments per receipts part. Each payment books a receipt (record_multi_invoice_payment:
 * journal, TDS row, voucher) and looks up its bank line, all in ONE call as the signed-in user, whose
 * statement_timeout is 8 s. Staging 7 Nov: part 0 of 250 went in, part 1 and every later part was
 * cancelled ("canceling statement due to statement timeout"). Measured on the local DB with 3,000 FY
 * sales and 3,000 statement lines: a part of 250 took 2.0 s, rising to 4.7 s as the books filled (each
 * payment is its own sub-transaction, and they pile up inside one call); a part of 50 took 0.4–0.8 s.
 * Cloud SQL is slower than the laptop, so 50 leaves the margin 250 did not. Same stable order, so the payments
 * of an old 250-part come again inside the new parts 0..4 and count as "already" (never booked twice).
 */
export const RECEIPTS_IMPORT_PART = 50;

export function partCount(n: number, size = IMPORT_PART): number {
  return Math.ceil(Math.max(0, n) / size);
}

/** Part `part` of `all`, or null when there is no such part. */
export function partOf<T>(all: readonly T[], part: unknown, size = IMPORT_PART): T[] | null {
  const p = Number(part);
  if (!Number.isInteger(p) || p < 0 || p >= partCount(all.length, size)) return null;
  return all.slice(p * size, (p + 1) * size);
}
