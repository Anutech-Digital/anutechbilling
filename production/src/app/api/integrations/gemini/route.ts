/**
 * Gemini (AI) integration — read + save the per-tenant API credentials so the
 * workspace owner can turn on real AI from Settings → Integrations instead of a
 * global Cloud Run env var.
 *
 *   GET    → configured? + model + masked key preview + updated_at
 *   POST   → upsert { api_key, model? }
 *   DELETE → clear the key
 *
 * The raw key NEVER leaves the server after save — only a masked preview.
 * Owner-only, mirroring the Razorpay/WhatsApp integration routes.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { trySealTenantSecrets } from "@/lib/crypto/tenant-secrets";
import { maskSecret } from "@/lib/crypto/vault";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

/* Kept in step with lib/ai/gemini.ts, which explains why this is a rolling alias and not
   a pinned version: gemini-2.5-flash 404d for new keys on 23 Aug 2026 and ListModels still
   reported it as available. Two DEFAULT_MODELs in one repo is a smell — they are separate
   today because this route validates a key before any tenant row exists. */
const DEFAULT_MODEL = "gemini-flash-latest";

const saveSchema = z
  .object({
    api_key: z.string().trim().min(20, "That doesn't look like a valid Gemini API key").max(200).optional(),
    model:   z.string().trim().max(60).optional(),
  })
  .refine((d) => d.api_key || d.model, { message: "Nothing to save" });

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
  return {
    tenantId: me.tenant_id as string,
    isOwner: me.role === "owner",
    // R-051: service-role writes carry the verified caller, so the audit log names them.
    admin: createAdminClientFor(authData.user.id),
  };
}

export async function GET() {
  const r = await resolveTenant("read");
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: 403 });

  const admin = r.admin;
  const { data, error } = await admin
    .from("tenant_secrets")
    .select("gemini_api_key, gemini_model, updated_at")
    .eq("tenant_id", r.tenantId)
    .maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // A global env key (Cloud Run) means AI works even without a tenant key.
  const envFallback = Boolean(process.env.GEMINI_API_KEY?.trim() && process.env.GEMINI_API_KEY!.trim().length >= 10);

  return NextResponse.json({
    ok:           true,
    configured:   Boolean(data?.gemini_api_key),
    env_fallback: envFallback,
    key_mask:     r.isOwner ? maskSecret(data?.gemini_api_key) : null,
    can_manage:   r.isOwner,
    model:        data?.gemini_model ?? DEFAULT_MODEL,
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

  // Patch only the provided fields — so changing the model alone preserves the
  // existing key (the UI never has the saved key to re-send).
  const patch: { tenant_id: string; gemini_api_key?: string; gemini_model?: string } = { tenant_id: r.tenantId };
  if (parsed.data.api_key) patch.gemini_api_key = parsed.data.api_key;
  if (parsed.data.model)   patch.gemini_model   = parsed.data.model.trim();

  // Seal the API key before it is stored. gemini_model is configuration, not a
  // credential, and is left readable. No master key = refuse (503 + next step),
  // never store the key in the clear (R-051).
  const sealed = trySealTenantSecrets(patch);
  if (!sealed.ok) return NextResponse.json({ ok: false, error: sealed.error }, { status: sealed.status });

  const admin = r.admin;
  const { error } = await admin
    .from("tenant_secrets")
    .upsert(sealed.row, { onConflict: "tenant_id" });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const r = await resolveTenant("manage");
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: 403 });

  const admin = r.admin;
  const { error } = await admin
    .from("tenant_secrets")
    .update({ gemini_api_key: null, gemini_model: null })
    .eq("tenant_id", r.tenantId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
