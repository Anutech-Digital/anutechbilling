/**
 * GET /api/integrations/google-reseller/callback  (R-824)
 *
 * Completes "Connect Google Reseller": exchanges the code, checks the Reseller scope really came
 * back (a box can be unticked on Google's screen), stores the token on the user's shared
 * user_google_tokens row (refresh token sealed, R-051) and returns to Settings → Integrations
 * with a one-word status the page turns into a toast.
 *
 * No token is ever put in the redirect, a log line or a response body (R-528).
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { mayDo } from "@/lib/auth/action-roles";
import { googleOAuthCreds, originFromRequest, googleResellerRedirectUri, exchangeCode, fetchGoogleEmail } from "@/lib/google/oauth";
import { refuseConnectWithoutVault, sealRefreshToken } from "@/lib/google/token-vault";
import { scopesLost, scopeLossMessage, hasResellerScope } from "@/lib/google/scope-union";
import { resellerReturnPath } from "@/lib/google/reseller-connect";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATE_COOKIE = "g_reseller_oauth_state";

export async function GET(request: NextRequest) {
  const origin = originFromRequest(request);
  const url = new URL(request.url);
  const savedState = request.cookies.get(STATE_COOKIE)?.value;
  const done = (status: string) => {
    const res = NextResponse.redirect(`${origin}${resellerReturnPath(status)}`);
    res.cookies.delete(STATE_COOKIE);
    return res;
  };

  if (url.searchParams.get("error")) return done("denied");
  const code = url.searchParams.get("code");
  if (!code) return done("error");
  if (!savedState || savedState !== url.searchParams.get("state")) return done("badstate");

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${origin}/login`);
  const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
  const profile = me as { tenant_id?: string | null; role?: string | null } | null;
  if (!mayDo(profile?.role, "integration.company")) return done("role");
  if (!profile?.tenant_id) return done("error");

  const creds = googleOAuthCreds();
  if (!creds) return done("notconfigured");
  // R-051: the refresh token is stored encrypted or not at all.
  if (refuseConnectWithoutVault("google-reseller/callback")) return done("notconfigured");

  try {
    const tokens = await exchangeCode(code, googleResellerRedirectUri(origin), creds);
    if (!hasResellerScope(tokens.scope)) return done("noscope");

    const email = await fetchGoogleEmail(tokens.access_token);
    const admin = createAdminClient();
    const { data: before } = await admin.from("user_google_tokens").select("scopes").eq("user_id", user.id).maybeSingle();
    const lossNote = scopeLossMessage(scopesLost((before as { scopes?: string | null } | null)?.scopes, tokens.scope));

    const { error } = await admin.from("user_google_tokens").upsert({
      user_id: user.id, tenant_id: profile.tenant_id, google_email: email,
      access_token: tokens.access_token,
      token_expiry: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString(),
      scopes: tokens.scope ?? null, last_error: lossNote,
      // refresh_token only arrives on consent — never overwrite a stored one with nothing.
      ...(tokens.refresh_token ? { refresh_token: sealRefreshToken(tokens.refresh_token) } : {}),
    }, { onConflict: "user_id" });
    if (error) throw error;

    return done(lossNote ? "connected_scopelost" : "connected");
  } catch (e) {
    // The message only — Google's error bodies carry no token, and we never log ours.
    console.error("[google-reseller/callback] failed:", (e as Error)?.message ?? "unknown");
    return done("error");
  }
}
