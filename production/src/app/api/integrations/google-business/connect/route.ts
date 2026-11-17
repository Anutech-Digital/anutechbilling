/**
 * GET /api/integrations/google-business/connect
 *
 * Starts the Business Profile consent. Its own flow, cookie and callback — same reasoning
 * as google-gmail/connect: the consent screen must say what the button says, and revoking
 * one integration must not take the others down. Asks for the union of what this user has
 * already granted (contacts, gmail) so this consent cannot narrow them — see
 * lib/google/scope-union.ts for the August 2026 incident that rule comes from.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { mayDo } from "@/lib/auth/action-roles";
import { googleOAuthCreds, originFromRequest, gbpRedirectUri, buildAuthUrl, GBP_SCOPES } from "@/lib/google/oauth";
import { unionScopes } from "@/lib/google/scope-union";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const origin = originFromRequest(request);
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${origin}/login`);
  /* S19: a company-wide account — owner / manager only (per-user Gmail and Contacts stay open). */
  const { data: me } = await createClient().from("users").select("role").eq("id", user.id).maybeSingle();
  if (!mayDo((me as { role?: string | null } | null)?.role, "integration.marketing")) {
    return NextResponse.redirect(`${origin}/marketing/google-business?gbp=role`);
  }

  const creds = googleOAuthCreds();
  if (!creds) return NextResponse.redirect(`${origin}/marketing/google-business?gbp=notconfigured`);

  // Admin client: user_google_tokens has RLS with no user policy (reads come back empty, not as errors).
  const { data: prior } = await createAdminClient().from("user_google_tokens").select("scopes").eq("user_id", user.id).maybeSingle();
  const scopes = unionScopes(GBP_SCOPES, (prior as { scopes?: string | null } | null)?.scopes);

  const state = crypto.randomUUID();
  const res = NextResponse.redirect(buildAuthUrl(creds.clientId, gbpRedirectUri(origin), state, scopes));
  res.cookies.set("g_gbp_oauth_state", state, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 600 });
  return res;
}
