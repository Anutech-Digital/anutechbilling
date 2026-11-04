/** GET /api/integrations/meta-ads/connect — start Facebook Login with ads_read. */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { mayDo } from "@/lib/auth/action-roles";
import { originFromRequest } from "@/lib/google/oauth";
import { metaAppCreds, metaAdsRedirectUri, buildMetaAuthUrl } from "@/lib/meta/meta-ads-api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const origin = originFromRequest(request);
  const { data: { user } } = await createClient().auth.getUser();
  if (!user) return NextResponse.redirect(`${origin}/login`);
  /* S19: a company-wide account — owner / manager only (per-user Gmail and Contacts stay open). */
  const { data: me } = await createClient().from("users").select("role").eq("id", user.id).maybeSingle();
  if (!mayDo((me as { role?: string | null } | null)?.role, "integration.company")) {
    return NextResponse.redirect(`${origin}/marketing/ads/accounts?platform=meta-ads&meta=role`);
  }
  const creds = metaAppCreds();
  if (!creds) return NextResponse.redirect(`${origin}/marketing/ads/accounts?platform=meta-ads&meta=notconfigured`);
  const state = crypto.randomUUID();
  const res = NextResponse.redirect(buildMetaAuthUrl(creds.appId, metaAdsRedirectUri(origin), state));
  res.cookies.set("meta_ads_oauth_state", state, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 600 });
  return res;
}
