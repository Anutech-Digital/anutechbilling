/**
 * GET /api/integrations/zoho-books/callback — R-1749.
 *
 * Zoho sends the person back here after consent. In order:
 *   1. "Deny" at Zoho → denied.  No server credentials → notconfigured.
 *   2. Signed in, own tenant, allowed role (owner / manager / accountant).
 *   3. State: valid signature, not expired, nonce = our httpOnly cookie, and the tenant + user
 *      it names = the person signed in NOW. Any mismatch → badstate, Zoho is not called.
 *   4. No vault key on this server → refuse (the token is stored encrypted or not at all).
 *   5. Exchange the code at accounts.zoho.in, store the refresh token SEALED on this tenant's
 *      tenant_secrets row, organization cleared (the owner picks it next on the card).
 * The token never goes to the browser; the redirect carries only a status word.
 * Zoho's `accounts-server` query param is ignored on purpose — the India DC is fixed.
 */
import { NextResponse, type NextRequest } from "next/server";
import { originFromRequest } from "@/lib/google/oauth";
import { refuseConnectWithoutVault } from "@/lib/google/token-vault";
import {
  SETTINGS_RETURN, STATE_COOKIE, ZOHO_STATUS_PARAM, zohoBooksCreds, zohoRedirectUri,
} from "@/lib/integrations/zoho-books/config";
import { verifyState } from "@/lib/integrations/zoho-books/state";
import { resolveZohoCaller, saveConnection } from "@/lib/integrations/zoho-books/store";
import { exchangeCode, ZohoApiError } from "@/lib/integrations/zoho-books/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const origin = originFromRequest(request);
  const back = (s: string) => {
    const res = NextResponse.redirect(`${origin}${SETTINGS_RETURN}&${ZOHO_STATUS_PARAM}=${s}`);
    res.cookies.set(STATE_COOKIE, "", { path: "/api/integrations/zoho-books", maxAge: 0 });
    return res;
  };
  const url = new URL(request.url);
  if (url.searchParams.get("error")) return back("denied");
  const code = url.searchParams.get("code");
  if (!code) return back("error");

  const creds = zohoBooksCreds();
  if (!creds) return back("notconfigured");

  const caller = await resolveZohoCaller();
  if (!caller) return NextResponse.redirect(`${origin}/login`);
  if (!caller.canManage) return back("role");

  const check = verifyState(url.searchParams.get("state"), creds.clientSecret, {
    nonce: request.cookies.get(STATE_COOKIE)?.value,
    tenantId: caller.tenantId,
    userId: caller.userId,
  });
  if (!check.ok) {
    console.warn(`[zoho-books/callback] state refused: ${check.reason}`);
    return back("badstate");
  }

  if (refuseConnectWithoutVault("zoho-books/callback")) return back("novault");

  try {
    const tokens = await exchangeCode(code, zohoRedirectUri(origin), creds);
    await saveConnection(caller.admin, caller.tenantId, caller.userId, tokens.refreshToken);
    return back("connected");
  } catch (e) {
    // Code only — never the token or the secret.
    console.error(`[zoho-books/callback] failed: ${e instanceof ZohoApiError ? e.code : "store"}`);
    return back("error");
  }
}
