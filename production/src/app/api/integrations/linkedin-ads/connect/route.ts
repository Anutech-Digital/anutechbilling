/** Start LinkedIn Advertising API consent. */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { mayDo } from "@/lib/auth/action-roles";
import { originFromRequest } from "@/lib/google/oauth";
import { LINKEDIN_ADS_SCOPES, linkedInAdsRedirectUri, linkedInAuthUrl, linkedInCreds } from "@/lib/integrations/linkedin/config";
import { readLinkedInAdsCredentials } from "@/lib/integrations/linkedin/store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const origin = originFromRequest(request);
  const { data: { user } } = await createClient().auth.getUser();
  if (!user) return NextResponse.redirect(`${origin}/login`);
  const { data: me } = await createClient().from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
  if (!mayDo(me?.role, "integration.company")) return NextResponse.redirect(`${origin}/marketing/ads?linkedin=role`);
  if (!me?.tenant_id) return NextResponse.redirect(`${origin}/marketing/ads?linkedin=error`);
  const creds = await readLinkedInAdsCredentials(createAdminClientFor(user.id), me.tenant_id) ?? linkedInCreds();
  if (!creds) return NextResponse.redirect(`${origin}/marketing/ads?linkedin=notconfigured`);
  const state = crypto.randomUUID();
  const res = NextResponse.redirect(linkedInAuthUrl(creds.clientId, linkedInAdsRedirectUri(origin), state, LINKEDIN_ADS_SCOPES));
  res.cookies.set("linkedin_ads_oauth_state", state, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 600 });
  return res;
}
