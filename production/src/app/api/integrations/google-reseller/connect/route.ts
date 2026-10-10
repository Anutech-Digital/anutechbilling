/**
 * GET /api/integrations/google-reseller/connect  (R-824)
 *
 * Starts the "Connect Google Reseller" consent: the Reseller scope (apps.order), offline access +
 * prompt=consent so Google returns a refresh token. Its own flow, cookie and callback, like
 * google-business/connect — the consent screen asks for exactly what the button says. Asks for
 * the union of what this user already granted (contacts, gmail…) so this consent cannot narrow
 * them (lib/google/scope-union.ts).
 *
 * The Reseller account is company-wide → owner / manager only (S19 "integration.company").
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { mayDo } from "@/lib/auth/action-roles";
import { googleOAuthCreds, originFromRequest, googleResellerRedirectUri, buildAuthUrl, GOOGLE_RESELLER_SCOPES } from "@/lib/google/oauth";
import { unionScopes } from "@/lib/google/scope-union";
import { resellerReturnPath } from "@/lib/google/reseller-connect";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const origin = originFromRequest(request);
  const back = (status: string) => NextResponse.redirect(`${origin}${resellerReturnPath(status)}`);

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${origin}/login`);
  const { data: me } = await supabase.from("users").select("role").eq("id", user.id).maybeSingle();
  if (!mayDo((me as { role?: string | null } | null)?.role, "integration.company")) return back("role");

  const creds = googleOAuthCreds();
  if (!creds) return back("notconfigured");

  const { data: prior } = await createAdminClient().from("user_google_tokens").select("scopes").eq("user_id", user.id).maybeSingle();
  const scopes = unionScopes(GOOGLE_RESELLER_SCOPES, (prior as { scopes?: string | null } | null)?.scopes);

  const state = crypto.randomUUID();
  const res = NextResponse.redirect(buildAuthUrl(creds.clientId, googleResellerRedirectUri(origin), state, scopes));
  res.cookies.set("g_reseller_oauth_state", state, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 600 });
  return res;
}
