/**
 * R-1970 / R-1975: the company the buy page and its thanks page sell as — the website tenant's
 * own row (name, logo, GSTIN, address, state, phone). Server only. A failed or slow read shows a
 * neutral header, never another company's name. Moved here from page.tsx so the thanks page
 * reads the same brand (until R-1975 it had a letter "R" and a typed company name).
 *
 * R-2024 (27 Oct 2026): the first load after a server start showed "Google Workspace" in the
 * header — ONE 3-second read on a cold connection, then null. Now:
 *   1. a failed or timed-out read is retried once after a short pause, inside ~6 s in all;
 *   2. the last good brand is kept in this process for 30 minutes, keyed by the tenant id, and
 *      used when both reads fail — never an entry of another tenant id;
 *   3. still nothing → the page asks GET /api/public/brand after it loads (use-buy-brand.ts);
 *   4. every failed read is logged with how long it took.
 */
import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/server";
import { websiteTenantId } from "@/lib/website-tenant";
import { brandFromTenant, type BuyBrand, type TenantBrandRow } from "./brand";

/** The columns the page shows — nothing else leaves the tenants row (the public endpoint too). */
export const BRAND_COLUMNS = "name, logo_url, gstin, address, pin_code, state, state_code, phone, email";

const FIRST_TRY_MS = 2_500;
const RETRY_PAUSE_MS = 250;
const SECOND_TRY_MS = 3_000;
/** Both tries and the pause — the page waits at most this long for the brand. */
export const BRAND_READ_BUDGET_MS = FIRST_TRY_MS + RETRY_PAUSE_MS + SECOND_TRY_MS;

const CACHE_TTL_MS = 30 * 60_000;
/** Last good brand per tenant id (this server process only). */
const lastGood = new Map<string, { brand: BuyBrand; at: number }>();

export function __resetBuyBrandCacheForTests(): void { lastGood.clear(); }

type ReadOutcome = { ok: true; brand: BuyBrand | null } | { ok: false };

type BrandClient = Pick<ReturnType<typeof createAdminClient>, "from">;

async function readOnce(client: BrandClient, tenantId: string, timeoutMs: number, attempt: number): Promise<ReadOutcome> {
  const started = Date.now();
  try {
    const { data, error } = await client
      .from("tenants")
      .select(BRAND_COLUMNS)
      .eq("id", tenantId)
      .abortSignal(AbortSignal.timeout(timeoutMs))
      .maybeSingle();
    if (error) {
      console.warn(`[buy/workspace] tenant brand read failed (try ${attempt}, ${Date.now() - started} ms):`, error.message);
      return { ok: false };
    }
    return { ok: true, brand: brandFromTenant(data as TenantBrandRow | null) };
  } catch (e) {
    console.warn(`[buy/workspace] tenant brand read failed (try ${attempt}, ${Date.now() - started} ms):`, e instanceof Error ? e.message : String(e));
    return { ok: false };
  }
}

/**
 * The website tenant's brand: a fresh read (with one retry), else this tenant's last good brand
 * from the past 30 minutes, else null. `client` lets the public route show it holds the service
 * role (admin-client-ratchet); the read is always pinned to websiteTenantId().
 */
export async function readBuyBrand(client: () => BrandClient = createAdminClient): Promise<BuyBrand | null> {
  const tenantId = websiteTenantId();
  if (!tenantId) return null;
  const admin = client();
  const started = Date.now();
  let out = await readOnce(admin, tenantId, FIRST_TRY_MS, 1);
  if (!out.ok) {
    await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS));
    const left = BRAND_READ_BUDGET_MS - (Date.now() - started);
    if (left > 250) out = await readOnce(admin, tenantId, Math.min(SECOND_TRY_MS, left), 2);
  }
  if (out.ok) {
    if (out.brand) lastGood.set(tenantId, { brand: out.brand, at: Date.now() });
    else lastGood.delete(tenantId);   // the row answered without a name: no stale brand over it
    return out.brand;
  }
  const hit = lastGood.get(tenantId);
  if (hit && Date.now() - hit.at <= CACHE_TTL_MS) {
    console.warn(`[buy/workspace] tenant brand: both reads failed in ${Date.now() - started} ms — showing the last good brand from ${Math.round((Date.now() - hit.at) / 1000)} s ago`);
    return hit.brand;
  }
  return null;
}

/* One read per request (React cache): generateMetadata (the tab title "Buy Google Workspace ·
   <tenant>") and the page share it — two parallel reads on a cold connection could let one time
   out and leave the title without the tenant name while the header had it. */
export const fetchBuyBrand = cache(() => readBuyBrand());
