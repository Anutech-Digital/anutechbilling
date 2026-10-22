/**
 * GET /api/integrations/google-business — is Business Profile connected for this user, and
 * can it actually sync? Mirrors the Gmail status route: "connected" means the scope is on
 * the stored token, not merely that a token exists. Never returns the tokens.
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { googleOAuthCreds } from "@/lib/google/oauth";
import { hasGbpScope } from "@/lib/google/scope-union";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { data: me } = await supabase.from("users").select("tenant_id").eq("id", user.id).maybeSingle();
  const admin = createAdminClient();
  // Any user of the tenant may have connected the listing; the page belongs to the tenant.
  const { data: locs } = me?.tenant_id
    ? await admin.from("gbp_locations").select("connected_user_id, last_synced_at, last_error").eq("tenant_id", me.tenant_id)
    : { data: [] as { connected_user_id: string; last_synced_at: string | null; last_error: string | null }[] };
  const connectedUserId = locs?.[0]?.connected_user_id ?? user.id;

  const { data: tok } = await admin
    .from("user_google_tokens").select("google_email, refresh_token, scopes, last_error").eq("user_id", connectedUserId).maybeSingle();
  const hasToken = Boolean(tok?.refresh_token);
  const canSync = hasToken && hasGbpScope(tok?.scopes);
  const lastSynced = (locs ?? []).map((l) => l.last_synced_at).filter(Boolean).sort().pop() ?? null;

  return NextResponse.json({
    configured: !!googleOAuthCreds(),
    connected: canSync,
    connectedByMe: connectedUserId === user.id,
    email: canSync ? tok?.google_email ?? null : null,
    lastSyncedAt: lastSynced,
    lastError: tok?.last_error ?? (locs ?? []).find((l) => l.last_error)?.last_error ?? null,
    reason: !googleOAuthCreds()
      ? "Google OAuth keys are not set in env."
      : !hasToken
        ? "No Google account is connected."
        : !canSync
          ? "Google account is connected but Business Profile permission was not granted. Connect again and keep \"Manage your business listings\" ticked."
          : "Ready.",
  });
}
