/**
 * Razorpay integration — read + save the per-tenant API credentials.
 *
 *   GET  → existence + mode + masked previews + webhook URL
 *   POST → upsert credentials (key_id prefix decides test/live mode)
 *   DELETE → clear credentials
 *
 * Public-key vs server-key distinction:
 *   - key_id (rzp_test_/rzp_live_...) is safe to surface to the client
 *     when launching the Razorpay Checkout widget.
 *   - key_secret + webhook_secret NEVER leave the server.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { razorpayReadiness, razorpayMode } from "@/lib/payments/razorpay-readiness";
import { sealTenantSecrets } from "@/lib/crypto/tenant-secrets";
import { buildSecretPatch } from "@/lib/integrations/secret-field";
import { maskSecret } from "@/lib/crypto/vault";

export const dynamic = "force-dynamic";
export const runtime  = "nodejs";

/**
 * Secrets are OPTIONAL here on purpose, and length is checked by
 * `resolveSecretField` rather than by zod.
 *
 * The dialog never prefills a secret — correct, since a server that hands a live
 * key secret back to the browser has already lost — so a blank box means "I did
 * not retype it", not "make it empty". zod's `.min(10)` on `key_secret` turned an
 * ordinary Save into a validation failure, and the optional `webhook_secret` was
 * worse: it sailed through and the route then wrote NULL over a live secret,
 * landing the workspace in the critical collect-without-reconcile state.
 */
const saveSchema = z.object({
  key_id:         z.string().trim().min(10).max(80)
                    .refine((v) => /^rzp_(test|live)_/.test(v),
                            "Key ID must start with rzp_test_ or rzp_live_"),
  key_secret:     z.string().trim().max(200).optional(),
  webhook_secret: z.string().trim().max(200).optional(),
  /** Explicit removal. A blank box never means this. */
  clear_webhook_secret: z.boolean().optional(),
});

/**
 * Preview for the UI. Delegates to the vault so a SEALED value reads "encrypted"
 * rather than a slice of envelope bytes, which would look like a corrupt key.
 */
function mask(s: string | null | undefined): string | null {
  return s ? maskSecret(s) : null;
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

function webhookUrlFor(tenantId: string, req: NextRequest): string {
  // On Cloud Run behind the proxy, req.nextUrl.origin resolves to the container's
  // internal http://0.0.0.0:8080 — useless to paste into Razorpay. Prefer the
  // canonical public URL, falling back to the request origin only in dev.
  const origin = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "") || req.nextUrl.origin;
  // The `tenant` param is load-bearing: /api/webhooks/razorpay reads it to pick
  // WHICH tenant's signing secret to verify against, and to reject an event
  // whose quote belongs to a different tenant. Registering the URL without it
  // falls back to the global env secret and skips that tenant check.
  return `${origin}/api/webhooks/razorpay?tenant=${encodeURIComponent(tenantId)}`;
}

export async function GET(req: NextRequest) {
  const r = await resolveTenant("read");
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: 403 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("tenant_secrets")
    .select("razorpay_mode, razorpay_key_id, razorpay_key_secret, razorpay_webhook_secret, updated_at")
    .eq("tenant_id", r.tenantId)
    .maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // `configured` used to mean "has key_id + key_secret" and the Settings card
  // rendered it as "Accepting payments" — true, and the wrong thing to measure:
  // without a webhook secret the app never learns that a payment happened. It is
  // kept here only so nothing that already reads it breaks, and it now means
  // exactly what it says: money can be collected. Reconciliation is reported
  // separately, because that is the half that was silently missing.
  const readiness = razorpayReadiness({
    keyId:         data?.razorpay_key_id,
    keySecret:     data?.razorpay_key_secret,
    webhookSecret: data?.razorpay_webhook_secret,
  });

  return NextResponse.json({
    ok:                    true,
    configured:            readiness.canCollect,
    readiness,
    mode:                  razorpayMode(data?.razorpay_key_id),
    key_id:                data?.razorpay_key_id ?? null,
    key_secret_mask:       r.isOwner ? mask(data?.razorpay_key_secret) : null,
    webhook_secret_mask:   r.isOwner ? mask(data?.razorpay_webhook_secret) : null,
    can_manage:            r.isOwner,
    webhook_url:           webhookUrlFor(r.tenantId, req),
    updated_at:            data?.updated_at ?? null,
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
  // Mode is inferred from the key_id prefix — single source of truth.
  const mode = v.key_id.startsWith("rzp_live_") ? "live" : "test";

  const admin = createAdminClient();

  // What is already stored decides whether a blank box is "keep" or "missing".
  const { data: current } = await admin
    .from("tenant_secrets")
    .select("razorpay_key_secret, razorpay_webhook_secret")
    .eq("tenant_id", r.tenantId)
    .maybeSingle();

  const { patch, errors, unchanged } = buildSecretPatch({
    razorpay_key_secret: {
      incoming: v.key_secret,
      hasExisting: Boolean(current?.razorpay_key_secret),
      required: true, minLength: 10, label: "Key secret",
    },
    razorpay_webhook_secret: {
      incoming: v.webhook_secret,
      hasExisting: Boolean(current?.razorpay_webhook_secret),
      clear: v.clear_webhook_secret === true,
      minLength: 8, label: "Webhook secret",
    },
  });

  if (errors.length > 0) {
    return NextResponse.json({ ok: false, error: errors.join(" ") }, { status: 400 });
  }

  // Seal only the fields actually being written. An untouched field is ABSENT
  // from the patch, so the upsert leaves its stored value alone — that absence is
  // the whole fix.
  const sealed = sealTenantSecrets(patch);

  const { error } = await admin
    .from("tenant_secrets")
    .upsert({
      tenant_id:       r.tenantId,
      razorpay_mode:   mode,
      razorpay_key_id: v.key_id,
      ...sealed.row,
    }, { onConflict: "tenant_id" });
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  // Say so when a secret had to be stored in the clear. Silence here would let
  // an operator believe their credentials are encrypted when they are not.
  if (sealed.storedInClear.length > 0) {
    console.warn(
      `[integrations/razorpay] stored in PLAINTEXT (${sealed.storedInClear.join(", ")}) — SECRETS_MASTER_KEY is not configured`,
    );
  }
  return NextResponse.json({
    ok: true, mode,
    encrypted: sealed.storedInClear.length === 0,
    // So the UI can say "webhook secret left unchanged" instead of implying it
    // was rewritten.
    unchanged,
  });
}

export async function DELETE() {
  const r = await resolveTenant("manage");
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: 403 });

  const admin = createAdminClient();
  const { error } = await admin
    .from("tenant_secrets")
    .update({
      razorpay_key_id:         null,
      razorpay_key_secret:     null,
      razorpay_webhook_secret: null,
    })
    .eq("tenant_id", r.tenantId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
