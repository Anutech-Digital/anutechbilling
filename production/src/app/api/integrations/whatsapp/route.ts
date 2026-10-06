/**
 * WhatsApp Business integration — read + save the per-tenant credentials.
 *
 *   GET  → existence flag + masked previews + a derived "webhook URL"
 *          Pardeep can paste into the Meta dashboard
 *   POST → upsert credentials. Validates shape; does NOT call upstream
 *          (Meta API ping happens via the "Test connection" button
 *          which hits /api/integrations/whatsapp/test below if added).
 *   DELETE → clear credentials (keeps row, nulls fields)
 *
 * Provider abstraction: column shape supports Meta + Gupshup + Twilio.
 * UI surfaces Meta fields first; other providers added when needed.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

const saveSchema = z.object({
  provider:                z.enum(["meta", "gupshup", "twilio"]).default("meta"),
  phone_number_id:         z.string().trim().min(1, "Phone Number ID is required").max(80),
  access_token:            z.string().trim().min(10, "Access token looks too short").max(500),
  business_account_id:     z.string().trim().max(80).optional(),
  app_secret:              z.string().trim().max(200).optional(),
  verify_token:            z.string().trim().max(200).optional(),
});

/** Mask a secret: show 4-leading and 4-trailing chars + dots. */
function mask(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  if (t.length <= 8) return "•".repeat(t.length);
  return `${t.slice(0, 4)}••••${t.slice(-4)}`;
}

/**
 * R-256: reading the STATUS (configured? mode? readiness) is open to owner / manager / billing,
 * the roles that see Settings > Integrations. A GET that was owner-only answered 403, the card
 * read that as "Not configured / simulation" and offered a Setup that then failed on save,
 * while the integration was live. Saving and clearing stay owner-only, and secret previews
 * (masks, tokens) go only to the owner.
 */
const READ_ROLES = new Set(["owner", "manager", "billing"]);

async function resolveTenant(access: "read" | "manage") {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return { error: "Not authenticated" as const };
  const { data: me, error } = await supabase
    .from("users")
    .select("tenant_id, role")
    .eq("id", authData.user.id)
    .single();
  if (error || !me) return { error: "User not linked to a tenant" as const };
  if (access === "manage" && me.role !== "owner") return { error: "Only the workspace owner can manage integration credentials" as const };
  if (access === "read" && !READ_ROLES.has(me.role)) return { error: "Your role cannot see integration settings" as const };
  return { tenantId: me.tenant_id as string, isOwner: me.role === "owner" };
}

/** Webhook URL Pardeep will paste into the Meta dashboard. Bound to the
 *  tenant via the verify token so we know which workspace owns inbounds. */
function webhookUrlFor(tenantId: string, req: NextRequest): string {
  const origin = req.nextUrl.origin;
  return `${origin}/api/webhooks/whatsapp?tenant=${encodeURIComponent(tenantId)}`;
}

export async function GET(req: NextRequest) {
  const r = await resolveTenant("read");
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: 403 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("tenant_secrets")
    .select("whatsapp_provider, whatsapp_phone_number_id, whatsapp_access_token, whatsapp_business_account_id, whatsapp_app_secret, whatsapp_verify_token, updated_at")
    .eq("tenant_id", r.tenantId)
    .maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({
    ok:           true,
    configured:   Boolean(data?.whatsapp_phone_number_id && data.whatsapp_access_token),
    provider:     data?.whatsapp_provider ?? "meta",
    phone_number_id:        data?.whatsapp_phone_number_id ?? null,
    access_token_mask:      r.isOwner ? mask(data?.whatsapp_access_token) : null,
    business_account_id:    data?.whatsapp_business_account_id ?? null,
    app_secret_mask:        r.isOwner ? mask(data?.whatsapp_app_secret) : null,
    verify_token:           r.isOwner ? (data?.whatsapp_verify_token ?? null) : null,
    can_manage:             r.isOwner,
    webhook_url:            webhookUrlFor(r.tenantId, req),
    updated_at:             data?.updated_at ?? null,
  });
}

export async function POST(req: NextRequest) {
  const r = await resolveTenant("manage");
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: 403 });

  let body: unknown;
  try { body = await req.json(); } catch { body = {}; }
  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 },
    );
  }
  const v = parsed.data;

  const admin = createAdminClient();
  const { error } = await admin
    .from("tenant_secrets")
    .upsert({
      tenant_id:                    r.tenantId,
      whatsapp_provider:            v.provider,
      whatsapp_phone_number_id:     v.phone_number_id,
      whatsapp_access_token:        v.access_token,
      whatsapp_business_account_id: v.business_account_id ?? null,
      whatsapp_app_secret:          v.app_secret          ?? null,
      whatsapp_verify_token:        v.verify_token        ?? null,
    }, { onConflict: "tenant_id" });
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const r = await resolveTenant("manage");
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: 403 });

  const admin = createAdminClient();
  const { error } = await admin
    .from("tenant_secrets")
    .update({
      whatsapp_phone_number_id:     null,
      whatsapp_access_token:        null,
      whatsapp_business_account_id: null,
      whatsapp_app_secret:          null,
      whatsapp_verify_token:        null,
    })
    .eq("tenant_id", r.tenantId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
