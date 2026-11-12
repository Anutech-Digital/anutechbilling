/**
 * GET /api/integrations/google-ads/connect — start the Google Ads (adwords scope) consent.
 * Own flow, cookie and callback (see google-gmail/connect for why); asks for the union of
 * scopes this user already holds so it cannot narrow Contacts / Gmail / Business Profile.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { mayDo } from "@/lib/auth/action-roles";
import { googleOAuthCreds, originFromRequest, googleAdsRedirectUri, buildAuthUrl, GOOGLE_ADS_SCOPES } from "@/lib/google/oauth";
import { unionScopes } from "@/lib/google/scope-union";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const origin = originFromRequest(request);
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${origin}/login`);
  /* S19: a company-wide account — owner / manager only (per-user Gmail and Contacts stay open). */
  const { data: me } = await createClient().from("users").select("role").eq("id", user.id).maybeSingle();
  if (!mayDo((me as { role?: string | null } | null)?.role, "integration.company")) {
    return NextResponse.redirect(`${origin}/marketing/ads/accounts?platform=google-ads&google=role`);
  }
  const creds = googleOAuthCreds();
  if (!creds) return NextResponse.redirect(`${origin}/marketing/ads/accounts?platform=google-ads&google=notconfigured`);

  const { data: prior } = await createAdminClient().from("user_google_tokens").select("scopes").eq("user_id", user.id).maybeSingle();
  const scopes = unionScopes(GOOGLE_ADS_SCOPES, (prior as { scopes?: string | null } | null)?.scopes);
  const state = crypto.randomUUID();
  const res = NextResponse.redirect(buildAuthUrl(creds.clientId, googleAdsRedirectUri(origin), state, scopes));
  res.cookies.set("g_ads_oauth_state", state, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 600 });
  return res;
}
