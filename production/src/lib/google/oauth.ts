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

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

/** openid+email to identify the account; contacts for read+write sync. */
export const GOOGLE_CONTACTS_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/contacts",
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
  const proto = h.get("x-forwarded-proto") ?? "https";
  if (host) return `${proto}://${host}`;
  const env = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (env) return env;
  return new URL(request.url).origin;
}

/** The redirect URI must match EXACTLY what's registered in Google Cloud. */
export function contactsRedirectUri(origin: string): string {
  return `${origin}/api/integrations/google-contacts/callback`;
}

export function buildAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_CONTACTS_SCOPES,
    access_type: "offline",     // → refresh token
    prompt: "consent",          // force refresh-token issuance on reconnect
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

export async function refreshAccessToken(
  refreshToken: string,
  creds: { clientId: string; clientSecret: string },
): Promise<GoogleTokenResponse> {
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
