/**
 * R-1927 (G-ONBOARD OB-6) — load the standard price list by itself when the owner saves
 * step 1 of the setup wizard and the company has no products yet.
 *
 * Before this the catalogue loaded only if the owner found "Load default catalog" in the
 * Import step; pressing Continue past it left an empty quote builder. The prices are the
 * code's DEFAULT_CATALOG via the existing useLoadDefaultCatalog — nothing new is priced here.
 *
 * Never over an existing catalogue (seeded support tiers do not count — productCount),
 * never while the list is still unknown, and never for a non-owner (R-1798: they save nothing).
 */
import { productCount } from "@/lib/items/catalog-state";

export function shouldAutoLoadCatalog(
  items: readonly { vendor: string }[] | null | undefined,
  canSave: boolean,
): boolean {
  if (!canSave || items == null) return false;
  return productCount(items) === 0;
}
