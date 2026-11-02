/**
 * POST /api/public/privacy-request/verify — R-2013: the 6-digit code from the email confirms
 * the request. The check and everything that follows run in ONE database call
 * (privacy_request_verify): 5 tries, 15-minute expiry, then status open + due_by (30 days),
 * the person's leads/customers linked, and for "withdraw consent" a consent_events 'withdrawn'
 * row per lead + the email suppressed — so offers, greetings and AI follow-ups stop at once.
 *
 * Website tenant only; per-IP limit. The code is hashed here (the database never sees it).
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { rateLimit, clientIp } from "@/lib/security/rate-limit";
import { websiteTenantId, websiteTenantMissingBody } from "@/lib/website-tenant";
import { verifySchema, verifyReasonMessage } from "@/lib/privacy/requests";
import { privacyCodeHash, privacyCodeSecret } from "@/lib/privacy/otp.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const noStore = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

type VerifyResult = { ok: boolean; reason?: string; left?: number; due_by?: string; already?: boolean; kind?: string };

export async function POST(request: NextRequest) {
  const tenantId = websiteTenantId();
  if (!tenantId) return noStore(websiteTenantMissingBody(), 503);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = verifySchema.safeParse(body);
  if (!parsed.success) {
    return noStore({ error: [...new Set(parsed.error.issues.map((i) => i.message))].join(", ") }, 400);
  }
  if (!rateLimit(`privacy-verify:ip:${clientIp(request.headers)}`, { limit: 20, windowMs: 10 * 60_000 }).ok) {
    return noStore({ error: "Too many tries from here. Wait 10 minutes and try again." }, 429);
  }
  const secret = privacyCodeSecret();
  if (!secret) return noStore({ error: "This form is not set up yet. Please email us instead." }, 503);

  const admin = createAdminClient() as unknown as { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }> };
  const { requestId, code } = parsed.data;
  const { data, error } = await admin.rpc("privacy_request_verify", {
    p_tenant_id: tenantId,
    p_id: requestId,
    p_otp_hash: privacyCodeHash(secret, requestId, code),
  });
  if (error) {
    console.error("[privacy-request/verify] rpc failed:", error.message);
    return noStore({ error: verifyReasonMessage("error") }, 500);
  }
  const r = (data ?? {}) as VerifyResult;
  if (!r.ok) {
    return noStore({ error: verifyReasonMessage(r.reason ?? "error", r.left), reason: r.reason ?? "error" }, r.reason === "not_found" ? 404 : 400);
  }
  return noStore({ ok: true, dueBy: r.due_by ?? null, kind: r.kind ?? null, already: r.already === true });
}
