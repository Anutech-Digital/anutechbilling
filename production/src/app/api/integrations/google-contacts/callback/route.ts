/**
 * GET /api/integrations/google-contacts/callback
 *
 * Google redirects here after consent. Verifies CSRF state, exchanges the code
 * for tokens, and stores them per-user in user_google_tokens via the service-role
 * admin client (the browser never sees the refresh token). Then bounces back to
 * Settings → Integrations.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import {
  googleOAuthCreds, originFromRequest, contactsRedirectUri,
  exchangeCode, fetchGoogleEmail,
} from "@/lib/google/oauth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const origin = originFromRequest(request);
  const settings = `${origin}/settings?tab=integrations`;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const err = url.searchParams.get("error");

  if (err) return NextResponse.redirect(`${settings}&google=denied`);
  if (!code) return NextResponse.redirect(`${settings}&google=error`);

  // CSRF: state must match the cookie we set at connect time.
  const cookieState = request.cookies.get("g_contacts_oauth_state")?.value;
  if (!state || !cookieState || state !== cookieState) {
    return NextResponse.redirect(`${settings}&google=badstate`);
  }

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${origin}/login`);

  const creds = googleOAuthCreds();
  if (!creds) return NextResponse.redirect(`${settings}&google=notconfigured`);

  try {
    const tokens = await exchangeCode(code, contactsRedirectUri(origin), creds);
    const email = await fetchGoogleEmail(tokens.access_token);

    const { data: me } = await supabase.from("users").select("tenant_id").eq("id", user.id).maybeSingle();
    if (!me?.tenant_id) return NextResponse.redirect(`${settings}&google=error`);

    const admin = createAdminClient();
    const expiry = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString();
    // refresh_token only comes back on first consent; keep the old one if absent.
    const patch = {
      user_id: user.id,
      tenant_id: me.tenant_id,
      google_email: email,
      access_token: tokens.access_token,
      token_expiry: expiry,
      scopes: tokens.scope ?? null,
      last_error: null,
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
    };

    const { error } = await admin.from("user_google_tokens").upsert(patch, { onConflict: "user_id" });
    if (error) throw error;

    const res = NextResponse.redirect(`${settings}&google=connected`);
    res.cookies.delete("g_contacts_oauth_state");
    return res;
  } catch (e) {
    console.error("[google-contacts/callback] failed:", e);
    return NextResponse.redirect(`${settings}&google=error`);
  }
}
