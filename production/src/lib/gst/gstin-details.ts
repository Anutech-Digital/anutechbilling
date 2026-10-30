/**
 * R-2168: GSTN's `lstupdt` is the date the registration record was last updated — NOT a
 * return filing date. It was saved as `last_return_filed` and shown as "Last return filed",
 * which made an owner think returns were not filed. It is `details_last_updated` now; rows
 * cached before the rename (tenants / customers .gstin_verification) still carry the old key.
 * A real return-filing status needs Sandbox's return-tracking API (its own card, per-call cost).
 */
export const GST_DETAILS_LAST_UPDATED_LABEL = "GST details last updated";

export function gstDetailsLastUpdated(
  v: { details_last_updated?: string | null; last_return_filed?: string | null } | null | undefined,
): string | null {
  return v?.details_last_updated ?? v?.last_return_filed ?? null;
}
