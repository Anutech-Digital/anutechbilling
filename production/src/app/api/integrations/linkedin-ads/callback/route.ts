/** Exchange LinkedIn Ads consent, discover ad accounts, then run the first metrics sync. */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { originFromRequest } from "@/lib/google/oauth";
import { exchangeLinkedInCode } from "@/lib/integrations/linkedin/api";
import { linkedInAdsRedirectUri, linkedInCreds } from "@/lib/integrations/linkedin/config";
import { listLinkedInAdAccounts } from "@/lib/linkedin/linkedin-ads-api";
import { sealLinkedInAdsToken } from "@/lib/linkedin/linkedin-ads-token-vault";
import { refuseConnectWithoutVault } from "@/lib/google/token-vault";
import { syncTenantAds } from "@/lib/marketing/ad-sync";
import { readLinkedInAdsCredentials } from "@/lib/integrations/linkedin/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const origin = originFromRequest(request); const url = new URL(request.url);
  const done = (status: string, why = "") => { const r = NextResponse.redirect(`${origin}/marketing/ads/accounts?platform=linkedin-ads&linkedin=${status}${why}`); r.cookies.delete("linkedin_ads_oauth_state"); return r; };
  if (url.searchParams.get("error")) return done("denied");
  const code = url.searchParams.get("code");
  if (!code || request.cookies.get("linkedin_ads_oauth_state")?.value !== url.searchParams.get("state")) return done("badstate");
  const { data: { user } } = await createClient().auth.getUser();
  if (!user) return NextResponse.redirect(`${origin}/login`);
  const { data: me } = await createClient().from("users").select("tenant_id").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) return done("error");
  const creds = await readLinkedInAdsCredentials(createAdminClient(), me.tenant_id) ?? linkedInCreds();
  if (!creds || refuseConnectWithoutVault("linkedin-ads/callback")) return done("notconfigured");
  try {
    const { accessToken, expiresAt } = await exchangeLinkedInCode(code, linkedInAdsRedirectUri(origin), creds);
    const accounts = await listLinkedInAdAccounts(accessToken);
    if (!accounts.length) return done("noaccounts");
    const admin = createAdminClient(); const sealed = sealLinkedInAdsToken(accessToken);
    for (const a of accounts) {
      const { data: existing, error: existingError } = await admin.from("ad_accounts")
        .select("enabled, archived_at").eq("tenant_id", me.tenant_id).eq("platform", "linkedin-ads").eq("account_id", a.id).maybeSingle();
      if (existingError) throw existingError;
      const { error } = await admin.from("ad_accounts").upsert({ tenant_id: me.tenant_id, platform: "linkedin-ads", account_id: a.id, name: a.name, currency: a.currency, connected_user_id: user.id, access_token: sealed, token_expires_at: expiresAt, archived_at: null, enabled: a.active && (existing && !existing.archived_at ? existing.enabled : true), updated_at: new Date().toISOString() }, { onConflict: "tenant_id,platform,account_id" });
      if (error) throw new Error(`Could not save LinkedIn ad account ${a.id}: ${error.message}`);
    }
    try {
      const sync = await syncTenantAds(admin, me.tenant_id, "connect");
      if (sync.errors.length) throw new Error(sync.errors[0]);
    }
    catch (e) { return done("connected_syncfailed", `&why=${encodeURIComponent((e as Error).message.slice(0, 300))}`); }
    return done("connected");
  } catch (e) { console.error("[linkedin-ads/callback] failed", e); return done("error", `&why=${encodeURIComponent((e as Error).message.slice(0, 300))}`); }
}
