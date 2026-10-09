/**
 * R-472 — how /items shows a row, so the catalogue reads like a price list.
 *
 * SKU: seeded rows carry the tenant's uuid on the end of their id so the id is unique
 * across tenants ("SUP-STANDARD-YR-d0000000000040008000000000000001"). That tail is ours,
 * not the owner's — it is hidden on screen (the stored id is unchanged).
 *
 * Avg margin ₹/seat: was averaged over EVERY active row, including support (our own
 * service, priced per year, margin 0 here) — so one support plan halved it while "Avg
 * margin %" next to it rightly skipped support. Both now average the same rows: the
 * priced ones (cost-coverage.ts).
 */

/** Hide a trailing 32-hex or dashed-uuid tenant suffix. Ids without one are unchanged. */
export function displaySku(id: string): string {
  return id
    .replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "")
    .replace(/-[0-9a-f]{32}$/i, "");
}

/** Average (msrp − wholesale) per seat per month over these rows, whole rupees; 0 when none. */
export function avgMarginPerSeat(rows: readonly { msrp: number; wholesale: number | null }[]): number {
  if (rows.length === 0) return 0;
  return Math.round(rows.reduce((s, r) => s + (r.msrp - (r.wholesale ?? 0)), 0) / rows.length);
}
