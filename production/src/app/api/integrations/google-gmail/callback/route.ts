/**
 * GET /api/integrations/google-gmail/callback
 *
 * Completes the Gmail send consent and stores the token.
 *
 * ─── THE SCOPE CHECK IS THE POINT ────────────────────────────────────────────
 * Google can return a token for FEWER scopes than were asked for: the consent
 * screen lets a user untick individual permissions. So "the user finished the
 * flow" does not mean "we can send". If gmail.send is missing we say so here,
 * now, instead of storing a token that authenticates perfectly and fails with a
 * 403 the first time a renewal reminder tries to go out — at which point the
 * failure looks like a Gmail outage rather than a permission nobody granted.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import {
  googleOAuthCreds, originFromRequest, gmailRedirectUri, exchangeCode, fetchGoogleEmail,
} from "@/lib/google/oauth";
import { canSendWithScopes } from "@/lib/email/provider";
import { scopesLost, scopeLossMessage } from "@/lib/google/scope-union";
import {
  outcomeFromGoogleError, outcomeFromExchangeError, type GmailConnectOutcome,
} from "@/lib/google/gmail-connect-result";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const origin = originFromRequest(request);
  const settings = `${origin}/settings?tab=integrations`;
  const url = new URL(request.url);

  const err  = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  /* R-160: Google's own code is kept. `admin_policy_enforced` (the tenant's Workspace admin
     blocks the app) used to read as "denied", which tells the user to just press Allow. */
  if (err)   return NextResponse.redirect(`${settings}&gmail=${outcomeFromGoogleError(err)}`);
  if (!code) return NextResponse.redirect(`${settings}&gmail=error`);

  const cookieState = request.cookies.get("g_gmail_oauth_state")?.value;
  if (!cookieState || cookieState !== url.searchParams.get("state")) {
    return NextResponse.redirect(`${settings}&gmail=badstate`);
  }

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${origin}/login`);

  const creds = googleOAuthCreds();
  if (!creds) return NextResponse.redirect(`${settings}&gmail=notconfigured`);

  /* R-160: exchange failures are classified from Google's body (redirect_uri_mismatch,
     invalid_client, invalid_grant) — each needs a different person to act, and all of them
     used to arrive on screen as the same silent `gmail=error`. */
  let tokens: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    tokens = await exchangeCode(code, gmailRedirectUri(origin), creds);
  } catch (e) {
    const outcome = outcomeFromExchangeError(e);
    console.error(`[google-gmail/callback] token exchange failed (${outcome}):`, e);
    return NextResponse.redirect(`${settings}&gmail=${outcome}`);
  }

  try {

    // Refuse before storing anything. A half-granted connection that LOOKS
    // connected is worse than no connection: the tenant would switch their
    // provider to Gmail believing mail now works.
    if (!canSendWithScopes(tokens.scope)) {
      const res = NextResponse.redirect(`${settings}&gmail=noscope`);
      res.cookies.delete("g_gmail_oauth_state");
      return res;
    }

    const email = await fetchGoogleEmail(tokens.access_token);

    const { data: me } = await supabase
      .from("users").select("tenant_id").eq("id", user.id).maybeSingle();
    if (!me?.tenant_id) return NextResponse.redirect(`${settings}&gmail=notenant`);

    const admin = createAdminClient();
    const expiry = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString();

    /* ── Kya is consent ne PEHLE SE mili koi permission cheen li? ─────────────
       Upar ka scope-check dekhta hai ki `gmail.send` AAYA — par ye nahi dekhta ki contacts
       BACHI. 26 Aug 2026 ko wahi hua: ye flow chala, gmail.send mila, aur Pardeep ka
       contacts grant chup-chaap gir gaya. Sync 11 din 403 deta raha, aur us baare me kisi
       screen par ek shabd nahi tha — pakda tab gaya jab DB ki `last_error` padhi gayi.

       Connect route ab union maangta hai, par user consent screen par checkbox untick kar
       sakta hai (isi file ka upar wala comment yahi kehta hai). To umeed ke bharose nahi —
       naap kar likh dete hain. */
    const { data: before } = await admin
      .from("user_google_tokens").select("scopes").eq("user_id", user.id).maybeSingle();
    const lost = scopesLost((before as { scopes?: string | null } | null)?.scopes, tokens.scope);
    const lossNote = scopeLossMessage(lost);

    // Same row as the contacts flow (one per user_id). refresh_token only comes
    // back on first consent, so an absent one must not overwrite the stored one
    // — doing that is how an integration works until the next token refresh and
    // then dies with no obvious cause.
    const patch = {
      user_id: user.id,
      tenant_id: me.tenant_id,
      google_email: email,
      access_token: tokens.access_token,
      token_expiry: expiry,
      scopes: tokens.scope ?? null,
      /* Nuksaan hua to wahi likho, `null` nahi. Ye wo jagah hai jahan ek toota hua
         integration apni wajah khud batata hai — usi field ne 26 Aug ko ye bug pakdaya. */
      last_error: lossNote,
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
    };

    const { error } = await admin
      .from("user_google_tokens")
      .upsert(patch, { onConflict: "user_id" });
    if (error) throw error;

    /* Gmail jud gaya, par doosra integration toot gaya — to "connected" kehkar bhej dena
       aadha sach hoga. Settings page ko farak bata dete hain. */
    const outcome: GmailConnectOutcome = lossNote ? "connected_scopelost" : "connected";
    const res = NextResponse.redirect(`${settings}&gmail=${outcome}`);
    res.cookies.delete("g_gmail_oauth_state");
    return res;
  } catch (e) {
    /* Google already said yes here; what failed is our side (userinfo or the DB write). */
    console.error("[google-gmail/callback] save failed:", e);
    return NextResponse.redirect(`${settings}&gmail=save_failed`);
  }
}
