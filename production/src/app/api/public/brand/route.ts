/**
 * GET /api/public/brand — R-2024 (27 Oct 2026, G-ADS).
 *
 * The buy page, its phone flow and the thank-you page read the website company's brand on the
 * server. On a cold start that read can fail even after its retry (fetch-brand.ts); the page then
 * asks here once after it loads, so the first ad visitor still sees the seller's own name and
 * logo instead of a neutral header.
 *
 *   - the website tenant only (websiteTenantId) — a tenant named in the request is ignored;
 *   - only what the page already shows: name, logo, GSTIN, address + PIN, state, phone, email
 *     (BRAND_COLUMNS) — the same fields the server-rendered header and footer print;
 *   - 60 per IP per 10 minutes (the middleware's public-API limit applies as well);
 *   - never cached by a browser or CDN (the company can change its logo).
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { clientIp, rateLimitShared } from "@/lib/security/rate-limit";
import { readBuyBrand } from "@/app/(public)/buy/workspace/_parts/fetch-brand";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BRAND_RATE = { limit: 60, windowMs: 10 * 60_000 } as const;
const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(request: NextRequest) {
  const rl = await rateLimitShared(`public-brand:ip:${clientIp(request.headers)}`, BRAND_RATE);
  if (!rl.ok) {
    return NextResponse.json({ brand: null }, { status: 429, headers: { ...NO_STORE, "Retry-After": String(rl.retryAfterSec) } });
  }
  const brand = await readBuyBrand(() => createAdminClient());
  return NextResponse.json({ brand }, { headers: NO_STORE });
}
