/**
 * Sandbox.co.in integration — read + save the per-tenant API credentials.
 *
 *   GET  → returns existence flags + masked previews (never the full secret)
 *   POST → updates the tenant_secrets row (RLS already enforces owner-only)
 *
 * GET is safe to call any time. POST validates the secrets shape but does
 * NOT call the upstream — that happens via /api/gstin/verify with a test
 * GSTIN once the visitor wants to confirm it works.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

const saveSchema = z.object({
  api_key:    z.string().trim().min(1, "API key required").max(200),
  api_secret: z.string().trim().min(1, "Secret required").max(400),
  api_base:   z.string().trim().url().optional(),
});

/** Show only the trailing 4 chars + leading 4 + middle dots — never the
 *  full value. The client uses this to display "Configured ✓ · ...AB12". */
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

export async function GET() {
  const r = await resolveTenant("read");
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: 403 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("tenant_secrets")
    .select("sandbox_api_key, sandbox_api_secret, sandbox_api_base, updated_at")
    .eq("tenant_id", r.tenantId)
    .maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({
    ok:           true,
    configured:   Boolean(data?.sandbox_api_key && data.sandbox_api_secret),
    api_key_mask: r.isOwner ? mask(data?.sandbox_api_key) : null,
    api_secret_mask: r.isOwner ? mask(data?.sandbox_api_secret) : null,
    can_manage:   r.isOwner,
    api_base:     data?.sandbox_api_base ?? "https://api.sandbox.co.in",
    updated_at:   data?.updated_at ?? null,
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
  const { api_key, api_secret, api_base } = parsed.data;

  const admin = createAdminClient();
  // Upsert so first-time and edit both work.
  const { error } = await admin
    .from("tenant_secrets")
    .upsert({
      tenant_id:           r.tenantId,
      sandbox_api_key:     api_key,
      sandbox_api_secret:  api_secret,
      sandbox_api_base:    api_base ?? "https://api.sandbox.co.in",
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
      sandbox_api_key:    null,
      sandbox_api_secret: null,
    })
    .eq("tenant_id", r.tenantId);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
