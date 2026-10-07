/**
 * GET /api/integrations/google-ads/callback — store the token, list the Ads accounts this
 * login can see into ad_accounts, and run the first spend sync. Redirects to /marketing/ads
 * with a one-word status the page turns into a toast.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { googleOAuthCreds, originFromRequest, googleAdsRedirectUri, exchangeCode, fetchGoogleEmail } from "@/lib/google/oauth";
import { refuseConnectWithoutVault, sealRefreshToken } from "@/lib/google/token-vault";
import { scopesLost, scopeLossMessage, hasGoogleAdsScope } from "@/lib/google/scope-union";
import { getFreshGoogleAdsAccessToken, listAdAccounts, googleAdsDeveloperToken } from "@/lib/google/google-ads-api";
import { syncTenantAds } from "@/lib/marketing/ad-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const origin = originFromRequest(request);
  const url = new URL(request.url);
  const done = (status: string, extra = "") => {
    const res = NextResponse.redirect(`${origin}/marketing/ads?google=${status}${extra}`);
    res.cookies.delete("g_ads_oauth_state");
    return res;
  };
  if (url.searchParams.get("error")) return done("denied");
  const code = url.searchParams.get("code");
  if (!code) return done("error");
  const cookieState = request.cookies.get("g_ads_oauth_state")?.value;
  if (!cookieState || cookieState !== url.searchParams.get("state")) return done("badstate");

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${origin}/login`);
  const creds = googleOAuthCreds();
  if (!creds) return done("notconfigured");
  // R-051: the refresh token is stored encrypted or not at all.
  if (refuseConnectWithoutVault("google-ads/callback")) return done("notconfigured");

  try {
    const tokens = await exchangeCode(code, googleAdsRedirectUri(origin), creds);
    if (!hasGoogleAdsScope(tokens.scope)) return done("noscope");
    const email = await fetchGoogleEmail(tokens.access_token);
    const { data: me } = await supabase.from("users").select("tenant_id").eq("id", user.id).maybeSingle();
    if (!me?.tenant_id) return done("error");

    const admin = createAdminClient();
    const { data: before } = await admin.from("user_google_tokens").select("scopes").eq("user_id", user.id).maybeSingle();
    const lossNote = scopeLossMessage(scopesLost((before as { scopes?: string | null } | null)?.scopes, tokens.scope));
    const { error } = await admin.from("user_google_tokens").upsert({
      user_id: user.id, tenant_id: me.tenant_id, google_email: email, access_token: tokens.access_token,
      token_expiry: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString(),
      scopes: tokens.scope ?? null, last_error: lossNote,
      // Encrypted at rest (R-051); opened only by refreshAccessToken, server-side.
      ...(tokens.refresh_token ? { refresh_token: sealRefreshToken(tokens.refresh_token) } : {}),
    }, { onConflict: "user_id" });
    if (error) throw error;

    if (!googleAdsDeveloperToken()) return done("nodevtoken");

    // Discover the accounts now, so the page has something to show and to switch off.
    try {
      const token = await getFreshGoogleAdsAccessToken(admin, user.id);
      const accounts = await listAdAccounts(token);
      if (accounts.length === 0) return done("noaccounts");
      for (const a of accounts) {
        await admin.from("ad_accounts").upsert({
          tenant_id: me.tenant_id, platform: "google-ads", account_id: a.id, name: a.name, currency: a.currency,
          login_customer_id: a.loginCustomerId, connected_user_id: user.id, updated_at: new Date().toISOString(),
        }, { onConflict: "tenant_id,platform,account_id" });
      }
      await syncTenantAds(admin, me.tenant_id, "connect");
    } catch (e) {
      console.error("[google-ads/callback] discovery/sync failed:", (e as Error).message);
      return done("connected_syncfailed", `&why=${encodeURIComponent((e as Error).message.slice(0, 300))}`);
    }
    return done(lossNote ? "connected_scopelost" : "connected");
  } catch (e) {
    console.error("[google-ads/callback] failed:", e);
    return done("error");
  }
}
