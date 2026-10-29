/**
 * R-2027 (27 Oct 2026): the Google Workspace price list the buy page sells from — the website
 * tenant's ENABLED Google Workspace rows of the Item Catalog. Server only.
 *
 * The first load after a server start logged "[buy/workspace] catalog fetch failed: TimeoutError"
 * — one 3-second read, then [] and the page priced itself from typed fallback tiers, which would
 * be wrong the day the catalogue changes (checkout charges the catalogue). Now, like the brand
 * (R-2024, the shared cold-read.ts):
 *   1. a failed or timed-out read is tried again with a growing pause, ~6 s in all;
 *   2. the last good list is kept in this process for 10 minutes per tenant id (short, so a price
 *      edit arrives quickly) and used only when every try fails — never another tenant id's list;
 *   3. still nothing → null ("not known yet"), never [] — the page then shows "Loading prices…"
 *      and asks GET /api/public/catalog/buy-workspace (use-buy-catalog.ts);
 *   4. every failed try is logged with how long it took.
 * [] means the catalogue answered and has no enabled Google Workspace rows (or no website tenant
 * is configured) — the page says prices are not available online, with ways to talk to us.
 */
import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/server";
import { websiteTenantId } from "@/lib/website-tenant";
import { lastGoodCache, readWithRetry, retryBudgetMs, type ReadOutcome, type RetryPlan } from "./cold-read";
import { publicBuyRow } from "./catalog-wire";
import type { CatalogItem } from "./tiers";

/** Only what the page prices with — wholesale and margin are never even read (R-328, our cost). */
const CATALOG_COLUMNS = "id, name, msrp, prices, is_active";

/** Three tries, the pause growing 250 → 500 ms. */
const CATALOG_RETRY: RetryPlan = { tries: [2_000, 1_750, 1_500], pauseMs: 250 };
export const CATALOG_READ_BUDGET_MS = retryBudgetMs(CATALOG_RETRY);

export const CATALOG_CACHE_TTL_MS = 10 * 60_000;
const lastGood = lastGoodCache<CatalogItem[]>(CATALOG_CACHE_TTL_MS);

export function __resetBuyCatalogCacheForTests(): void { lastGood.clear(); }

type CatalogClient = Pick<ReturnType<typeof createAdminClient>, "from">;

async function readOnce(client: CatalogClient, tenantId: string, timeoutMs: number, attempt: number): Promise<ReadOutcome<CatalogItem[]>> {
  const started = Date.now();
  try {
    const { data, error } = await client
      .from("items")
      .select(CATALOG_COLUMNS)
      .eq("tenant_id", tenantId)
      .eq("vendor", "google")
      .eq("kind", "main")
      .eq("is_active", true)
      .ilike("name", "Google Workspace%")
      .order("msrp", { ascending: true })
      .abortSignal(AbortSignal.timeout(timeoutMs));
    if (error) {
      console.warn(`[buy/workspace] catalog read failed (try ${attempt}, ${Date.now() - started} ms):`, error.message);
      return { ok: false };
    }
    const rows = (data ?? []) as Array<Omit<CatalogItem, "wholesale" | "margin_pct">>;
    return { ok: true, value: rows.map((r) => publicBuyRow({ ...r, wholesale: 0, margin_pct: null })) };
  } catch (e) {
    console.warn(`[buy/workspace] catalog read failed (try ${attempt}, ${Date.now() - started} ms):`, e instanceof Error ? e.message : String(e));
    return { ok: false };
  }
}

/**
 * The website tenant's buy-page price list: a fresh read (with retries), else this tenant's last
 * good list from the past 10 minutes, else null. `client` lets the public route show it holds
 * the service role (admin-client-ratchet); the read is always pinned to websiteTenantId().
 */
export async function readBuyCatalog(client: () => CatalogClient = createAdminClient): Promise<CatalogItem[] | null> {
  const tenantId = websiteTenantId();
  if (!tenantId) {
    console.error("[buy/workspace] BUY_PAGE_TENANT_ID is not set — set it in .env.local to your local workspace id (R-1499).");
    return [];
  }
  const admin = client();
  const started = Date.now();
  const out = await readWithRetry((ms, n) => readOnce(admin, tenantId, ms, n), CATALOG_RETRY);
  if (out.ok) {
    lastGood.set(tenantId, out.value);   // an honest empty list replaces an older full one
    return out.value;
  }
  const hit = lastGood.get(tenantId);
  if (hit) {
    console.warn(`[buy/workspace] catalog: every read failed in ${Date.now() - started} ms — showing the last good price list from ${Math.round(hit.ageMs / 1000)} s ago`);
    return hit.value;
  }
  console.error(`[buy/workspace] catalog: every read failed in ${Date.now() - started} ms and no recent list — the page will load prices itself`);
  return null;
}

/** One read per request (React cache). */
export const fetchBuyCatalog = cache(() => readBuyCatalog());
