/**
 * GET  /api/webhooks/meta  → Meta verification handshake (hub.mode / hub.verify_token / hub.challenge)
 * POST /api/webhooks/meta  → Lead Ads "leadgen" notices → leads (source "meta-ads")   — R-117
 *
 * Setup (Meta app → Webhooks → Page → subscribe field "leadgen"):
 *   Callback URL  https://<app host>/api/webhooks/meta
 *   Verify token  the value of META_LEADS_VERIFY_TOKEN
 * Env names and the one-tenant rule: lib/meta-leads/leadgen.server.ts.
 *
 * Security:
 *   - GET: verify token compared in constant time; no token configured → 403.
 *   - POST: X-Hub-Signature-256 over the RAW body with META_APP_SECRET, fail closed — no secret
 *     → every POST refused (lib/crypto/webhook-signature.ts explains why that is not optional).
 *   - No META_LEADS_TENANT_ID → refused (503): a lead is never written to a guessed workspace.
 *   - Service-role writes; nothing is sent to anyone (no email, no WhatsApp, no AI reply).
 *
 * Owner: the R-111 BEFORE INSERT trigger assigns one only if an owner has ticked people for
 * "New leads" on /team; otherwise the lead stays unassigned.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { verifyMetaSignature, signatureRefusalReason } from "@/lib/crypto/webhook-signature";
import { parseLeadgenWebhook } from "@/lib/meta-leads/leadgen";
import { ingestMetaLead, readMetaLeadsConfig } from "@/lib/meta-leads/leadgen.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode !== "subscribe" || !token || !challenge) {
    return NextResponse.json({ error: "invalid handshake" }, { status: 400 });
  }
  const { verifyToken } = readMetaLeadsConfig();
  if (!verifyToken) {
    return NextResponse.json({ error: "no verify token configured" }, { status: 403 });
  }
  if (!timingSafeEqualStr(token, verifyToken)) {
    return NextResponse.json({ error: "verify_token mismatch" }, { status: 403 });
  }
  return new NextResponse(challenge, { status: 200, headers: { "content-type": "text/plain" } });
}

export async function POST(req: NextRequest) {
  const cfg = readMetaLeadsConfig();
  const raw = await req.text();

  const verdict = verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"), cfg.appSecret);
  if (!verdict.ok) {
    console.warn(`[webhooks/meta] refused: ${signatureRefusalReason(verdict.reason)}`);
    return NextResponse.json({ error: "signature refused" }, { status: verdict.reason === "not_configured" ? 503 : 401 });
  }

  if (!cfg.tenantId) {
    console.error("[webhooks/meta] refused: META_LEADS_TENANT_ID is not set (or not a uuid) — no workspace to put leads in");
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  let body: unknown;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  /* META_LEADS_PAGE_IDS set → only those Pages; another Page subscribed to the same app is ignored. */
  const all = parseLeadgenWebhook(body);
  const refs = all.filter((r) => cfg.pageIds.length === 0 || (r.pageId !== null && cfg.pageIds.includes(r.pageId)));
  const admin = createAdminClient();
  const counts = { created: 0, duplicate: 0, already_imported: 0, failed: 0, ignored: all.length - refs.length };

  for (const ref of refs) {
    const out = await ingestMetaLead({ admin, tenantId: cfg.tenantId, ref, cfg });
    counts[out.kind]++;
    if (out.kind === "failed") console.error(`[webhooks/meta] lead ${ref.leadgenId} not saved: ${out.message}`);
  }

  /* A failed insert answers 500 so Meta re-delivers; the deterministic lead id keeps the
     re-delivery from duplicating the ones that did save. */
  return NextResponse.json({ ok: counts.failed === 0, ...counts }, { status: counts.failed > 0 ? 500 : 200 });
}
