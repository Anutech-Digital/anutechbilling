/**
 * GET /api/public/catalog/buy-workspace — R-2027 (27 Oct 2026, G-ADS).
 *
 * /buy/workspace reads its price list on the server (fetch-catalog.ts). On a cold start that read
 * can fail even after its retries; the page then shows "Loading prices…" with every buy button
 * locked and asks here once, so the first ad visitor gets the catalogue's prices — never typed
 * fallback prices. (/api/public/catalog/workspace is the company website's list: it drops
 * Business Plus, has no row ids, and may answer a day old — not what the buy page prices with.)
 *
 *   - the website tenant only (websiteTenantId) — a tenant named in the request is ignored;
 *   - only what the page prices with: id, name, msrp, prices.{annual,monthly}.msrp — never
 *     wholesale or margin; Business Plus without a price (R-328) — catalog-wire.ts;
 *   - price list unknown (every read failed, nothing recent) → 503 { items: null }, never an
 *     empty list the page would read as "no plans";
 *   - 60 per IP per 10 minutes (the middleware's public-API limit applies as well);
 *   - never cached by a browser or CDN (a price edit must show at once).
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { clientIp, rateLimitShared } from "@/lib/security/rate-limit";
import { readBuyCatalog } from "@/app/(public)/buy/workspace/_parts/fetch-catalog";
import { toWire } from "@/app/(public)/buy/workspace/_parts/catalog-wire";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CATALOG_RATE = { limit: 60, windowMs: 10 * 60_000 } as const;
const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(request: NextRequest) {
  const rl = await rateLimitShared(`public-buy-catalog:ip:${clientIp(request.headers)}`, CATALOG_RATE);
  if (!rl.ok) {
    return NextResponse.json({ items: null }, { status: 429, headers: { ...NO_STORE, "Retry-After": String(rl.retryAfterSec) } });
  }
  const items = await readBuyCatalog(() => createAdminClient());
  if (items === null) return NextResponse.json({ items: null }, { status: 503, headers: NO_STORE });
  return NextResponse.json({ items: toWire(items) }, { headers: NO_STORE });
}
