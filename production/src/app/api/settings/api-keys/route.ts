/**
 * Owner-facing API-key management (session-authenticated).
 *   GET  → list this tenant's keys (metadata only — never the hash/plaintext)
 *   POST → mint a new key; returns the plaintext ONCE (never stored/retrievable)
 *          body { label?, scopes? } — scopes from API_SCOPES (R-327), default ["read"]
 *
 * Owner-only: an API key can read all of a tenant's billing data, so only the
 * owner may create one. Tenant isolation is also enforced by RLS.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { generateApiKey } from "@/lib/api-keys/keys";
import { DEFAULT_SCOPES, parseScopes } from "@/lib/api-keys/scopes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function context() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return null;
  const { data: me } = await supabase
    .from("users").select("tenant_id, role").eq("id", authData.user.id).single();
  if (!me) return null;
  return { supabase, userId: authData.user.id, tenantId: me.tenant_id, role: me.role };
}

export async function GET() {
  const ctx = await context();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await ctx.supabase
    .from("api_keys")
    .select("id, label, key_prefix, scopes, last_used_at, revoked_at, created_at")
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

export async function POST(req: NextRequest) {
  const ctx = await context();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx.role !== "owner") {
    return NextResponse.json({ error: "Only the owner can create API keys" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { label?: string; scopes?: unknown };
  const label = (body.label ?? "").toString().trim().slice(0, 60) || "API key";
  const scopes = body.scopes === undefined ? DEFAULT_SCOPES : parseScopes(body.scopes);
  if (!scopes) {
    return NextResponse.json({ error: "Pick at least one valid scope (read, telecalling)" }, { status: 400 });
  }

  const { plaintext, hash, keyPrefix } = generateApiKey();
  const { data, error } = await ctx.supabase
    .from("api_keys")
    .insert({
      tenant_id:  ctx.tenantId,
      label,
      key_prefix: keyPrefix,
      key_hash:   hash,
      scopes,
      created_by: ctx.userId,
    })
    .select("id, label, key_prefix, scopes, created_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Plaintext is returned exactly once — the client shows it, we never store it.
  return NextResponse.json({ ...data, key: plaintext });
}
