/**
 * GET /api/integrations/meta-ads/callback — exchange the code for a long-lived token, list
 * the ad accounts into ad_accounts (token on each row, per tenant), first sync.
 * R-1884: the token is stored SEALED (lib/meta/meta-token-vault.ts) or not at all.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { originFromRequest } from "@/lib/google/oauth";
import { metaAppCreds, metaAdsRedirectUri, exchangeMetaCode, listMetaAdAccounts } from "@/lib/meta/meta-ads-api";
import { syncTenantAds } from "@/lib/marketing/ad-sync";
import { refuseConnectWithoutVault } from "@/lib/google/token-vault";
import { sealMetaToken } from "@/lib/meta/meta-token-vault";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const origin = originFromRequest(request);
  const url = new URL(request.url);
  const done = (status: string, extra = "") => {
    const res = NextResponse.redirect(`${origin}/marketing/ads?meta=${status}${extra}`);
    res.cookies.delete("meta_ads_oauth_state");
    return res;
  };
  if (url.searchParams.get("error")) return done("denied");
  const code = url.searchParams.get("code");
  if (!code) return done("error");
  const cookieState = request.cookies.get("meta_ads_oauth_state")?.value;
  if (!cookieState || cookieState !== url.searchParams.get("state")) return done("badstate");

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${origin}/login`);
  const creds = metaAppCreds();
  if (!creds) return done("notconfigured");
  // R-1884: no master key = the token could not be stored safely; refuse before burning the code.
  if (refuseConnectWithoutVault("meta-ads/callback")) return done("notconfigured");
  const { data: me } = await supabase.from("users").select("tenant_id").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) return done("error");

  try {
    const { accessToken, expiresAt } = await exchangeMetaCode(code, metaAdsRedirectUri(origin), creds);
    const accounts = await listMetaAdAccounts(accessToken);
    if (accounts.length === 0) return done("noaccounts");
    const admin = createAdminClient();
    const sealed = sealMetaToken(accessToken);
    for (const a of accounts) {
      await admin.from("ad_accounts").upsert({
        tenant_id: me.tenant_id, platform: "meta-ads", account_id: a.id, name: a.name, currency: a.currency,
        connected_user_id: user.id, access_token: sealed, token_expires_at: expiresAt, updated_at: new Date().toISOString(),
        // A closed/disabled account (status ≠ 1) is kept but not synced.
        enabled: a.status === 1,
      }, { onConflict: "tenant_id,platform,account_id" });
    }
    try { await syncTenantAds(admin, me.tenant_id, "connect"); }
    catch (e) { return done("connected_syncfailed", `&why=${encodeURIComponent((e as Error).message.slice(0, 300))}`); }
    return done("connected");
  } catch (e) {
    console.error("[meta-ads/callback] failed:", e);
    return done("error", `&why=${encodeURIComponent((e as Error).message.slice(0, 300))}`);
  }
}
