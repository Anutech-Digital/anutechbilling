/**
 * POST /api/public/privacy-request — R-2013 (2 Nov 2026, goal G-DPDP).
 *
 * The public "Your data" form (/privacy/request): a person asks the website's company to see,
 * correct or delete their data, to withdraw consent, or to nominate someone. This step saves
 * the request UNCONFIRMED and emails a 6-digit code; /verify confirms it. Only a confirmed
 * request reaches the owner's inbox (Settings → Privacy requests), with its due-by date.
 *
 * Website tenant only (never one the caller names), Turnstile, per-IP and per-email limits.
 * The answer never says whether the email is a known lead or customer.
 */
import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/server";
import { turnstileRefusal } from "@/lib/security/turnstile-guard";
import { rateLimit, clientIp } from "@/lib/security/rate-limit";
import { websiteTenantId, websiteTenantMissingBody } from "@/lib/website-tenant";
import { hashIp } from "@/app/api/public/consent/record.server";
import { privacyRequestSchema, PRIVACY_CODE_TTL_MIN } from "@/lib/privacy/requests";
import { newPrivacyCode, privacyCodeHash, privacyCodeSecret, sendPrivacyCode } from "@/lib/privacy/otp.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FROM_EMAIL = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";
const noStore = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: NextRequest) {
  const tenantId = websiteTenantId();
  if (!tenantId) return noStore(websiteTenantMissingBody(), 503);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const bot = await turnstileRefusal(request.headers, body);
  if (bot) return bot;

  const parsed = privacyRequestSchema.safeParse(body);
  if (!parsed.success) {
    return noStore({ error: [...new Set(parsed.error.issues.map((i) => i.message))].join(", ") }, 400);
  }
  const { fullName, email, phone, kind, details } = parsed.data;

  if (!rateLimit(`privacy:ip:${clientIp(request.headers)}`, { limit: 5, windowMs: 10 * 60_000 }).ok ||
      !rateLimit(`privacy:email:${email}`, { limit: 3, windowMs: 60 * 60_000 }).ok) {
    return noStore({ error: "Too many requests from here. Wait an hour, or use the code from the email we already sent." }, 429);
  }

  const secret = privacyCodeSecret();
  if (!secret) {
    console.error("[privacy-request] no OTP hash secret on this deployment");
    return noStore({ error: "This form is not set up yet, so nothing was saved. Please email us instead." }, 503);
  }

  const admin = createAdminClient() as unknown as { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const id = randomUUID();
  const code = newPrivacyCode();
  const { error } = await admin.from("privacy_requests").insert({
    id,
    tenant_id: tenantId,
    full_name: fullName,
    email,
    phone: phone ?? null,
    kind,
    details: details ?? null,
    otp_hash: privacyCodeHash(secret, id, code),
    otp_expires_at: new Date(Date.now() + PRIVACY_CODE_TTL_MIN * 60_000).toISOString(),
    ip_hash: hashIp(clientIp(request.headers)),
  });
  if (error) {
    console.error("[privacy-request] insert failed:", error.message);
    return noStore({ error: "Could not save your request. Try again in a minute, or email us." }, 500);
  }

  const { data: tenant } = await admin.from("tenants").select("name").eq("id", tenantId).maybeSingle();
  const sent = await sendPrivacyCode({
    to: email, name: fullName, code, kind, company: (tenant as { name?: string } | null)?.name || "us",
    tenantId, from: FROM_EMAIL,
  }).catch(() => false);
  if (!sent) {
    return noStore({ error: "We could not email the code. Check the address and send the form again." }, 502);
  }
  return noStore({ ok: true, requestId: id, minutes: PRIVACY_CODE_TTL_MIN });
}
