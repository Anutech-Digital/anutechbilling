/**
 * GET /api/integrations/zoho-books/connect — R-1749.
 *
 * Starts Zoho OAuth (India DC) for the signed-in person's OWN tenant: a signed state that
 * names this tenant + user, plus an httpOnly nonce cookie; then a full-page redirect to
 * Zoho's consent screen (read-only scopes, offline access, consent every time).
 * Owner / manager / accountant only. Without ZOHO_BOOKS_CLIENT_ID / _SECRET on the server it
 * goes straight back to Settings with "not set up".
 */
import { NextResponse, type NextRequest } from "next/server";
import { originFromRequest } from "@/lib/google/oauth";
import {
  buildZohoAuthUrl, SETTINGS_RETURN, STATE_COOKIE, STATE_TTL_MS, ZOHO_STATUS_PARAM, zohoBooksCreds, zohoRedirectUri,
} from "@/lib/integrations/zoho-books/config";
import { newNonce, signState } from "@/lib/integrations/zoho-books/state";
import { resolveZohoCaller } from "@/lib/integrations/zoho-books/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const origin = originFromRequest(request);
  const back = (s: string) => NextResponse.redirect(`${origin}${SETTINGS_RETURN}&${ZOHO_STATUS_PARAM}=${s}`);

  const caller = await resolveZohoCaller();
  if (!caller) return NextResponse.redirect(`${origin}/login`);
  const creds = zohoBooksCreds();
  if (!creds) return back("notconfigured");
  if (!caller.canManage) return back("role");

  const nonce = newNonce();
  const state = signState({ tenantId: caller.tenantId, userId: caller.userId, nonce }, creds.clientSecret);
  const res = NextResponse.redirect(buildZohoAuthUrl(creds.clientId, zohoRedirectUri(origin), state));
  res.cookies.set(STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: origin.startsWith("https://"),
    sameSite: "lax",
    path: "/api/integrations/zoho-books",
    maxAge: Math.floor(STATE_TTL_MS / 1000),
  });
  return res;
}
