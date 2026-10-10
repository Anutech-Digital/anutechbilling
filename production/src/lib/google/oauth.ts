/**
 * Google OAuth helpers for the Contacts integration.
 *
 * This is a DEDICATED OAuth client (env GOOGLE_OAUTH_CLIENT_ID/SECRET), separate
 * from Supabase's login OAuth — because two-way sync needs a durable refresh
 * token (offline access) that a background cron can use, which the login session
 * token can't provide.
 *
 * Scope note: `contacts` (read+write) is a Google "sensitive" scope. In testing
 * mode it works for allow-listed test users immediately; production multi-tenant
 * use requires Google's OAuth app verification.
 */
import { type NextRequest } from "next/server";
import { openRefreshToken } from "./token-vault";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

/**
 * Google Business Profile — accounts, locations, reviews, performance. One scope covers all
 * four APIs (Google has no read-only one). Its own consent flow, for the reason the Gmail
 * block below gives: the consent screen must say what the button says.
 */
/** Google Ads (adwords) — read spend per campaign. Its own consent, like the others. */
export const GOOGLE_ADS_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/adwords",
].join(" ");

/**
 * Google Workspace Reseller (R-824) — read the reseller's subscriptions. Its own consent, like
 * the others: the button says "Connect Google Reseller" and the screen asks for exactly that.
 * `apps.order` (10 Oct decision) so later seat/renewal work needs no second consent; today the
 * app only READS with it.
 */
export const GOOGLE_RESELLER_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/apps.order",
].join(" ");

export const GBP_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/business.manage",
].join(" ");

/** openid+email to identify the account; contacts for read+write sync. */
export const GOOGLE_CONTACTS_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/contacts",
].join(" ");

/**
 * Sending scope, kept SEPARATE from the contacts scopes on purpose.
 *
 * gmail.send is send-only: it cannot read, list or delete a single message. That
 * is the whole reason to prefer it over an SMTP App Password, which grants full
 * mailbox access — storing one of those per tenant would be materially worse than
 * storing a send-only API key.
 *
 * Separate because the consent screen lists what it is asking for, and bundling
 * "send email as you" into a button labelled "Connect Google Contacts" is the
 * kind of thing that makes people click Deny — rightly.
 */
export const GMAIL_SEND_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.send",
].join(" ");

/**
 * Reading the sales mailbox, so enquiries reach the app without a forwarder.
 *
 * ─── WHY THIS EXISTS (30 Aug 2026) ──────────────────────────────────────────
 * Until today, mail reached the Enquiries screen through an Apps Script in Gmail that
 * searched the mailbox on a 5-minute timer and POSTed each message to
 * /api/webhooks/inbound-email. That chain has six links and it broke at a silent one:
 * a stale copy of the script was posting an old `?key=` secret that matches nothing Cloud
 * Run accepts, so every run 401'd, and the mail sat labelled `erp-sent` — marked delivered
 * — while nothing reached the app for two days. Nobody could have seen it: the failure was
 * a log line in a Google account nobody opens.
 *
 * The connection needed to remove that chain was already here. `user_google_tokens` holds
 * a refresh token for google_email = sales@anutech.in — the exact mailbox — granted for
 * gmail.send. Only the reading half was missing.
 *
 * ─── readonly, NOT modify ───────────────────────────────────────────────────
 * `gmail.readonly` cannot label, archive or delete a single message. The forwarder needed
 * `modify` because a label was its memory of what it had already sent; this does not,
 * because `inbound_emails.message_id` is UNIQUE and Gmail's own message id goes in it. The
 * de-duplication lives in the database, where it can be inspected, instead of in a mailbox
 * label that only one script can see.
 *
 * That matters beyond tidiness: a label is a WRITE to the customer's mailbox, and the day
 * that write went wrong is the day the mail stopped arriving.
 *
 * Kept separate from the other two for the reason the block above gives — a consent screen
 * should say what it is asking for, and "read your mail" is not something to smuggle into a
 * button labelled Contacts.
 */
export const GMAIL_READ_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
].join(" ");

export function googleOAuthCreds(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Absolute origin for building redirect URIs. Mirrors the login callback's
 * forwarded-host logic (Cloud Run binds 0.0.0.0, so request.url origin is wrong)
 * and falls back to NEXT_PUBLIC_APP_URL, then the request origin.
 */
export function originFromRequest(request: NextRequest): string {
  const h = request.headers;
  const host = h.get("x-forwarded-host") ?? h.get("host");
  // Localhost has no x-forwarded-proto, so the https default produced
  // `https://localhost:3000/...` and Google answered redirect_uri_mismatch —
  // the registered URI is http. Invisible on Cloud Run, which always sets the
  // header, so this only ever surfaces the first time someone runs the OAuth
  // flow locally. Google permits http ONLY for localhost, so the exception is
  // exactly as narrow as the rule it is working around.
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host ?? "");
  const proto = h.get("x-forwarded-proto") ?? (isLocal ? "http" : "https");
  if (host) return `${proto}://${host}`;
  const env = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (env) return env;
  return new URL(request.url).origin;
}

/** The redirect URI must match EXACTLY what's registered in Google Cloud. */
export function contactsRedirectUri(origin: string): string {
  return `${origin}/api/integrations/google-contacts/callback`;
}

/**
 * Separate callback from contacts, and therefore a SECOND authorised redirect
 * URI to register in Google Cloud Console.
 *
 * Sharing one callback would be less setup but the handler could no longer tell
 * which consent it was completing, so it could not decide what to store or where
 * to send the user back to. Two URIs, two unambiguous handlers.
 */
export function googleAdsRedirectUri(origin: string): string {
  return `${origin}/api/integrations/google-ads/callback`;
}

/** R-824: its own callback — a second authorised redirect URI to register in Google Cloud. */
export function googleResellerRedirectUri(origin: string): string {
  return `${origin}/api/integrations/google-reseller/callback`;
}

export function gbpRedirectUri(origin: string): string {
  return `${origin}/api/integrations/google-business/callback`;
}

export function gmailRedirectUri(origin: string): string {
  return `${origin}/api/integrations/google-gmail/callback`;
}

/**
 * @param scope Space-separated scopes. Defaults to contacts so the existing
 *        caller keeps its behaviour — a default that silently changed what a
 *        consent screen asks for would be a nasty way to break trust.
 */
export function buildAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  scope: string = GOOGLE_CONTACTS_SCOPES,
): string {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    access_type: "offline",     // → refresh token
    prompt: "consent",          // force refresh-token issuance on reconnect
    /**
     * Load-bearing for BOTH flows, and easy to talk yourself out of.
     *
     * Contacts and Gmail write the same `user_google_tokens` row (one per
     * user_id), so the second consent replaces the first one's access token and
     * `scopes`. Without this flag, connecting Gmail after Contacts would store a
     * send-only token and contacts sync would start returning 403 — an
     * integration broken by connecting a different one.
     *
     * With it, Google returns a token carrying everything the account has
     * granted this client, so `scopes` describes the token accurately and
     * neither flow can knock the other over.
     */
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${p.toString()}`;
}

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

export async function exchangeCode(
  code: string,
  redirectUri: string,
  creds: { clientId: string; clientSecret: string },
): Promise<GoogleTokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as GoogleTokenResponse;
}

/**
 * Trade a STORED refresh token for a fresh access token.
 *
 * Takes the value exactly as read from `user_google_tokens.refresh_token` — the
 * encrypted envelope, or a legacy plaintext token (R-051). This is the ONE place
 * it is opened, server-side, immediately before going to Google; every caller
 * (contacts, Gmail send + inbox cron, Business Profile, Ads) passes the column
 * through untouched, so none of them can forget to decrypt.
 */
export async function refreshAccessToken(
  storedRefreshToken: string,
  creds: { clientId: string; clientSecret: string },
): Promise<GoogleTokenResponse> {
  const refreshToken = openRefreshToken(storedRefreshToken);
  if (!refreshToken) throw new Error("No refresh token — please reconnect Google");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Google token refresh failed: ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as GoogleTokenResponse;
}

export async function fetchGoogleEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return null;
    const data = (await res.json()) as { email?: string };
    return data.email ?? null;
  } catch {
    return null;
  }
}
