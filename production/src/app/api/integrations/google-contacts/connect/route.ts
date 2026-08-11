/**
 * GET /api/integrations/google-contacts/connect
 *
 * Kicks off the dedicated Google OAuth flow for Contacts sync: sets a CSRF state
 * cookie and redirects the signed-in user to Google's consent screen (offline
 * access → refresh token). The matching callback stores the tokens.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { googleOAuthCreds, originFromRequest, contactsRedirectUri, buildAuthUrl } from "@/lib/google/oauth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const origin = originFromRequest(request);
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${origin}/login`);

  const creds = googleOAuthCreds();
  if (!creds) {
    // Not configured yet (Pardeep hasn't added the OAuth client env vars).
    return NextResponse.redirect(`${origin}/settings?tab=integrations&google=notconfigured`);
  }

  const state = crypto.randomUUID();
  const url = buildAuthUrl(creds.clientId, contactsRedirectUri(origin), state);

  const res = NextResponse.redirect(url);
  // Short-lived, httpOnly CSRF cookie verified in the callback.
  res.cookies.set("g_contacts_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
