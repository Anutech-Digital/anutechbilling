/**
 * GET /api/integrations/google-business/callback
 *
 * Completes the Business Profile consent, stores the token on the user's shared
 * user_google_tokens row, checks the scope actually came back (a user can untick it on
 * Google's screen), and runs the first sync right away so the page is never empty after
 * "Connect". Redirects to the GBP page with a one-word status the page turns into a toast.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { googleOAuthCreds, originFromRequest, gbpRedirectUri, exchangeCode, fetchGoogleEmail } from "@/lib/google/oauth";
import { refuseConnectWithoutVault, sealRefreshToken } from "@/lib/google/token-vault";
import { scopesLost, scopeLossMessage, hasGbpScope } from "@/lib/google/scope-union";
import { syncTenantGbp } from "@/lib/google/gbp-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const origin = originFromRequest(request);
  const page = `${origin}/marketing/google-business`;
  const url = new URL(request.url);
  const done = (status: string) => {
    const res = NextResponse.redirect(`${page}?gbp=${status}`);
    res.cookies.delete("g_gbp_oauth_state");
    return res;
  };

  if (url.searchParams.get("error")) return done("denied");
  const code = url.searchParams.get("code");
  if (!code) return done("error");
  const cookieState = request.cookies.get("g_gbp_oauth_state")?.value;
  if (!cookieState || cookieState !== url.searchParams.get("state")) return done("badstate");

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${origin}/login`);
  const creds = googleOAuthCreds();
  if (!creds) return done("notconfigured");
  // R-051: the refresh token is stored encrypted or not at all.
  if (refuseConnectWithoutVault("google-business/callback")) return done("notconfigured");

  try {
    const tokens = await exchangeCode(code, gbpRedirectUri(origin), creds);
    if (!hasGbpScope(tokens.scope)) return done("noscope");

    const email = await fetchGoogleEmail(tokens.access_token);
    const { data: me } = await supabase.from("users").select("tenant_id").eq("id", user.id).maybeSingle();
    if (!me?.tenant_id) return done("error");

    const admin = createAdminClient();
    const { data: before } = await admin.from("user_google_tokens").select("scopes").eq("user_id", user.id).maybeSingle();
    const lossNote = scopeLossMessage(scopesLost((before as { scopes?: string | null } | null)?.scopes, tokens.scope));

    const { error } = await admin.from("user_google_tokens").upsert({
      user_id: user.id, tenant_id: me.tenant_id, google_email: email,
      access_token: tokens.access_token,
      token_expiry: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString(),
      scopes: tokens.scope ?? null, last_error: lossNote,
      // refresh_token only arrives on first consent — never overwrite a stored one with nothing.
      // Encrypted at rest (R-051); opened only by refreshAccessToken, server-side.
      ...(tokens.refresh_token ? { refresh_token: sealRefreshToken(tokens.refresh_token) } : {}),
    }, { onConflict: "user_id" });
    if (error) throw error;

    // First sync now, so the page has the listing when it opens. A failure here is a
    // Google-side setup problem (APIs not enabled / quota 0); the sync records the reason
    // and the page shows it — the token itself is stored and fine.
    try { await syncTenantGbp(admin, user.id, me.tenant_id, "connect"); }
    catch (e) { console.error("[google-business/callback] first sync failed:", (e as Error).message); return done("connected_syncfailed"); }

    return done(lossNote ? "connected_scopelost" : "connected");
  } catch (e) {
    console.error("[google-business/callback] failed:", e);
    return done("error");
  }
}
