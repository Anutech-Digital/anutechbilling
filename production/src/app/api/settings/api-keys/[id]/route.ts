/**
 * /api/settings/api-keys/{id}
 *   PATCH  → change a key's scopes (R-327). Body { scopes: ApiScope[] }. Never returns the
 *            key or its hash — only id, label, key_prefix, scopes.
 *   DELETE → revoke a key (soft: sets revoked_at). A revoked key is rejected by /api/v1 auth.
 * Owner-only, tenant-scoped (explicit tenant filter + RLS api_keys_update_owner).
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { parseScopes } from "@/lib/api-keys/scopes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The signed-in owner's tenant, or the response to send instead (401 / 403). */
async function ownerContext(forbidden: string) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return { denied: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  }
  const { data: me } = await supabase
    .from("users").select("tenant_id, role").eq("id", authData.user.id).single();
  if (!me || me.role !== "owner") {
    return { denied: NextResponse.json({ error: forbidden }, { status: 403 }) } as const;
  }
  return { denied: null, supabase, tenantId: me.tenant_id as string } as const;
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await ownerContext("Only the owner can change API key scopes");
  if (ctx.denied) return ctx.denied;

  const body = (await req.json().catch(() => ({}))) as { scopes?: unknown };
  const scopes = parseScopes(body.scopes);
  if (!scopes) {
    return NextResponse.json({ error: "Pick at least one valid scope (read, telecalling)" }, { status: 400 });
  }

  const { data, error } = await ctx.supabase
    .from("api_keys")
    .update({ scopes })
    .eq("id", params.id)
    .eq("tenant_id", ctx.tenantId)
    .is("revoked_at", null)
    .select("id, label, key_prefix, scopes")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Key not found or already revoked" }, { status: 404 });
  return NextResponse.json(data);
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await ownerContext("Only the owner can revoke API keys");
  if (ctx.denied) return ctx.denied;

  const { error } = await ctx.supabase
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", params.id)
    .eq("tenant_id", ctx.tenantId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ revoked: true });
}
