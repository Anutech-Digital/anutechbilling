/**
 * POST /api/public/consent — R-2010 (27 Oct 2026, G-DPDP).
 *
 * The website's cookie banner (site/components/chrome/ConsentBanner.tsx) records each choice
 * here, so we can show WHICH notice a visitor answered, WHEN, and that a later "Only necessary"
 * withdrew an earlier "Accept all" (DPDP Act 2023 s.6 / Rules 2025). The browser keeps its own
 * copy in localStorage; this is the server record.
 *
 *   - insert-only (public.consent_events; no update / delete grant exists);
 *   - the website tenant's row (websiteTenantId), never a tenant the caller names;
 *   - IP stored only as an HMAC (record.server.ts), user agent trimmed to 400 characters;
 *   - 20 per IP per 10 minutes (the middleware's public-API limit applies as well).
 *
 * A record that cannot be written is logged and answered { ok: true } — the visitor's choice
 * still holds in their browser, and a consent banner must never show an error.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { websiteTenantId } from "@/lib/website-tenant";
import { clientIp, rateLimitShared } from "@/lib/security/rate-limit";
import { CONSENT_PURPOSE_META, hashIp, type ConsentRow } from "./record.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  anonId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  choice: z.enum(["all", "essential"]),
  noticeVersion: z.string().min(1).max(40),
  page: z.string().max(200).regex(/^\//).optional(),
});

const CONSENT_RATE = { limit: 20, windowMs: 10 * 60_000 } as const;

export async function POST(request: NextRequest) {
  const ip = clientIp(request.headers);
  const rl = await rateLimitShared(`consent:ip:${ip}`, CONSENT_RATE);
  if (!rl.ok) {
    return NextResponse.json({ ok: false }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  }

  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false }, { status: 400 });
  const v = parsed.data;

  const tenantId = websiteTenantId();
  if (!tenantId) return NextResponse.json({ ok: true });

  const row: ConsentRow = {
    tenant_id: tenantId,
    anon_id: v.anonId.toLowerCase(),
    lead_id: null,
    quote_id: null,
    purpose: CONSENT_PURPOSE_META,
    choice: v.choice === "all" ? "granted" : "denied",
    notice_version: v.noticeVersion,
    source: "banner",
    page: v.page ?? null,
    ip_hash: hashIp(ip),
    user_agent: request.headers.get("user-agent")?.slice(0, 400) || null,
  };
  try {
    /* consent_events is not in database.generated.ts yet (that file is behind the migrations). */
    const { error } = await createAdminClient().from("consent_events" as never).insert(row as never);
    if (error) console.error("[public/consent] insert failed:", error.message);
  } catch (e) {
    console.error("[public/consent] insert failed:", e instanceof Error ? e.message : e);
  }
  return NextResponse.json({ ok: true });
}
