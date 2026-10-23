/**
 * R-1786 — the server side of the price book (catalog-prices.ts): reads the website company's
 * `items` rows by SKU when CATALOG_FROM_DB is on.
 *
 *   flag off                    → the code book; no database read at all (today's behaviour).
 *   flag on, read OK            → catalogue prices; a SKU with no usable row keeps its code
 *                                 price and is logged once per read (fail-safe, never ₹0).
 *   flag on, read fails/slow    → the last good read (up to 24 h old), else the code book —
 *                                 logged either way. A checkout is never blocked by the catalogue.
 *
 * Cached per server instance for 60 s (Items page edit → site and checkout within a minute),
 * per tenant. The read is narrow: SKU, name, price and the public metadata — never `wholesale`.
 */
import { createAdminClient } from "@/lib/supabase/server";
import { buildPriceBook, catalogFromDbEnabled, codePriceBook, CORE_SKUS, type CatalogRow, type PriceBook } from "./catalog-prices";

export const CATALOG_TTL_MS = 60_000;
export const CATALOG_MAX_STALE_MS = 24 * 60 * 60 * 1000;
export const CATALOG_READ_BUDGET_MS = 4_000;

interface Cached { at: number; book: PriceBook }
const fresh = new Map<string, Cached>();
const lastGood = new Map<string, Cached>();

export function forgetCatalogPricesForTests(): void {
  fresh.clear();
  lastGood.clear();
}

/** Only these columns — the public API shapes from them, and cost never enters the book. */
const COLUMNS = "sku, name, msrp, hsn, term_months, fulfilment, engine_ref, is_public";

async function readRows(tenantId: string): Promise<CatalogRow[]> {
  const admin = createAdminClient();
  const read = admin
    .from("items")
    .select(COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .in("sku", CORE_SKUS.map((s) => s.sku));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${CATALOG_READ_BUDGET_MS} ms`)), CATALOG_READ_BUDGET_MS);
  });
  try {
    const { data, error } = await Promise.race([read, budget]);
    if (error) throw new Error(error.message);
    return (data ?? []) as CatalogRow[];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The price book for this request. `tenantId` = the company the website sells for
 * (websiteTenantId() / buyPageTenantId()); null → the code book (logged when the flag is on).
 */
export async function getPriceBook(tenantId: string | null, now = Date.now()): Promise<PriceBook> {
  if (!catalogFromDbEnabled()) return codePriceBook();
  if (!tenantId) {
    console.warn("[catalog-prices] CATALOG_FROM_DB is on but the website company is not set (BUY_PAGE_TENANT_ID) — using the code prices.");
    return codePriceBook();
  }
  const hit = fresh.get(tenantId);
  if (hit && now - hit.at < CATALOG_TTL_MS) return hit.book;

  try {
    const book = buildPriceBook(await readRows(tenantId));
    if (book.fallbacks.length) {
      console.warn(
        `[catalog-prices] no usable items row for ${book.fallbacks.join(", ")} — charging the code price for ${book.fallbacks.length === 1 ? "it" : "them"}. ` +
          "Add or re-activate the row on the Items page (or run seed_core_catalog for this company).",
      );
    }
    const entry = { at: now, book };
    fresh.set(tenantId, entry);
    lastGood.set(tenantId, entry);
    return book;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const kept = lastGood.get(tenantId);
    if (kept && now - kept.at <= CATALOG_MAX_STALE_MS) {
      console.warn(`[catalog-prices] items read failed (${msg}) — using the prices read ${Math.round((now - kept.at) / 60000)} min ago.`);
      return kept.book;
    }
    console.error(`[catalog-prices] items read failed (${msg}) — using the code prices.`);
    return codePriceBook();
  }
}
