/**
 * R-1979 (26 Oct 2026, G-ADS): Settings → Integrations → Meta (Pixel + Conversions API).
 *
 *   GET    → pixel id, whether a CAPI token is stored (masked for the owner), test code
 *   POST   → save pixel id (+ CAPI token, sealed in the vault; + optional test code)
 *   DELETE → remove all three (no pixel script, no server event from then on)
 *
 * Same rules as the Razorpay card (api/integrations/razorpay): reading the status is open to
 * owner / manager / billing; saving and clearing are owner-only; the token never leaves the
 * server and a blank token box means "keep the stored one". No master key → the save is refused
 * (503), never stored in the clear (R-051).
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { trySealTenantSecrets } from "@/lib/crypto/tenant-secrets";
import { buildSecretPatch } from "@/lib/integrations/secret-field";
import { maskSecret } from "@/lib/crypto/vault";
import { cleanPixelId } from "@/lib/meta/pixel-ids";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const saveSchema = z.object({
  pixel_id: z.string().trim().refine((v) => cleanPixelId(v) !== null, "Pixel ID is the number from Events Manager (digits only)"),
  capi_token: z.string().trim().max(500).optional(),
  test_event_code: z.string().trim().max(40).regex(/^[A-Za-z0-9_-]*$/, "Test code: letters and numbers only").optional(),
  clear_capi_token: z.boolean().optional(),
});

const READ_ROLES = new Set(["owner", "manager", "billing"]);

async function resolveTenant(access: "read" | "manage") {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return { error: "Not authenticated" as const };
  const { data: me, error } = await supabase.from("users").select("tenant_id, role").eq("id", authData.user.id).single();
  if (error || !me) return { error: "User not linked to a tenant" as const };
  if (access === "manage" && me.role !== "owner") return { error: "Only the workspace owner can manage integration credentials" as const };
  if (access === "read" && !READ_ROLES.has(me.role)) return { error: "Your role cannot see integration settings" as const };
  return { tenantId: me.tenant_id as string, isOwner: me.role === "owner", admin: createAdminClientFor(authData.user.id) };
}

/* The Meta columns are newer than the generated DB types (R-1979 migration) — read loosely. */
type Loose = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function GET(_req: NextRequest) {
  const r = await resolveTenant("read");
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: 403 });
  const { data, error } = await (r.admin as unknown as Loose)
    .from("tenant_secrets")
    .select("meta_pixel_id, meta_capi_token, meta_test_event_code")
    .eq("tenant_id", r.tenantId)
    .maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  const row = (data ?? {}) as { meta_pixel_id?: string | null; meta_capi_token?: string | null; meta_test_event_code?: string | null };
  return NextResponse.json({
    ok: true,
    pixel_id: row.meta_pixel_id ?? null,
    capi_token_set: Boolean(row.meta_capi_token),
    capi_token_mask: r.isOwner && row.meta_capi_token ? maskSecret(row.meta_capi_token) : null,
    test_event_code: row.meta_test_event_code ?? null,
    can_manage: r.isOwner,
  });
}

export async function POST(req: NextRequest) {
  const r = await resolveTenant("manage");
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: 403 });
  let body: unknown;
  try { body = await req.json(); } catch { body = {}; }
  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues.map((i) => i.message).join(", ") }, { status: 400 });
  }
  const v = parsed.data;
  const admin = r.admin as unknown as Loose;
  const { data: current } = await admin.from("tenant_secrets").select("meta_capi_token").eq("tenant_id", r.tenantId).maybeSingle();
  const { patch, errors } = buildSecretPatch({
    meta_capi_token: {
      incoming: v.capi_token,
      hasExisting: Boolean((current as { meta_capi_token?: string | null } | null)?.meta_capi_token),
      clear: v.clear_capi_token === true,
      minLength: 20,
      label: "Conversions API token",
    },
  });
  if (errors.length) return NextResponse.json({ ok: false, error: errors.join(" ") }, { status: 400 });
  const sealed = trySealTenantSecrets(patch);
  if (!sealed.ok) return NextResponse.json({ ok: false, error: sealed.error }, { status: sealed.status });
  const { error } = await admin.from("tenant_secrets").upsert({
    tenant_id: r.tenantId,
    meta_pixel_id: cleanPixelId(v.pixel_id),
    meta_test_event_code: v.test_event_code ? v.test_event_code : null,
    ...sealed.row,
  }, { onConflict: "tenant_id" });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const r = await resolveTenant("manage");
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: 403 });
  const { error } = await (r.admin as unknown as Loose)
    .from("tenant_secrets")
    .update({ meta_pixel_id: null, meta_capi_token: null, meta_test_event_code: null })
    .eq("tenant_id", r.tenantId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
