/**
 * R-824 — getGoogleAccessToken(): the ONE way a server route gets a Google access token.
 *
 * Wires ./google-token-core.ts (the order and the reasons, tested) to the real stores:
 *   - `user_google_tokens` (the "Connect Google …" buttons; refresh token sealed, R-051)
 *   - the Auth.js session cookie (gat / grt / gexp / gscope — AUTH_PROVIDER=authjs), refreshed
 *     with grt and written back to the same encrypted cookie
 *   - Supabase's provider_token (AUTH_PROVIDER=gotrue, the old path, unchanged)
 *
 * R-528: the token is returned to SERVER code only. Never put it in a response body, a log line
 * or the session JSON; routes send the `reason` (and plain-English text) instead.
 */
import "server-only";
import { cookies } from "next/headers";
import { encode, getToken } from "next-auth/jwt";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { googleOAuthCreds, refreshAccessToken } from "@/lib/google/oauth";
import { resealIfPlain } from "@/lib/google/token-vault";
import { hasContactsScope, hasResellerScope } from "@/lib/google/scope-union";
import { authProvider } from "./authjs";
import {
  resolveGoogleToken,
  type GoogleNeed, type GoogleTokenResult, type Refreshed, type SessionGoogle, type StoredConnection,
} from "./google-token-core";

export type { GoogleNeed, GoogleTokenReason, GoogleTokenResult } from "./google-token-core";
export { classifyGoogleApiError, googleReasonMessage } from "./google-token-core";

/** What Auth.js's Google sign-in asks for (authjs.ts) — cookies from before gscope existed. */
const LOGIN_SCOPES = "openid email profile";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60;
const COOKIE_NAMES = { secure: "__Secure-authjs.session-token", plain: "authjs.session-token" } as const;

export function needHasScope(need: GoogleNeed, scopes: string | null): boolean {
  if (need === "reseller") return hasResellerScope(scopes);
  // Contacts import reads with contacts.readonly; the two-way sync grant (contacts) covers it too.
  return hasContactsScope(scopes) || (scopes ?? "").split(/\s+/).includes("https://www.googleapis.com/auth/contacts.readonly");
}

/** The client Auth.js signs in with — its refresh tokens can only be redeemed by the same client. */
function authjsGoogleCreds(): { clientId: string; clientSecret: string } | null {
  const clientId = (process.env.AUTH_GOOGLE_ID ?? process.env.GOOGLE_OAUTH_CLIENT_ID)?.trim();
  const clientSecret = (process.env.AUTH_GOOGLE_SECRET ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET)?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

interface ConnRow { user_id: string; access_token: string | null; refresh_token: string | null; token_expiry: string | null; scopes: string | null }

async function readConnectionRow(need: GoogleNeed, userId: string): Promise<ConnRow | null> {
  // Admin client: user_google_tokens has RLS with no user policy.
  const admin = createAdminClient();
  const cols = "user_id, access_token, refresh_token, token_expiry, scopes";
  const { data: own } = await admin.from("user_google_tokens").select(cols).eq("user_id", userId).maybeSingle();
  const mine = own as ConnRow | null;
  if (mine && needHasScope(need, mine.scopes)) return mine;
  if (need !== "reseller") return mine;
  // The Reseller account is company-wide: the owner connects it once, everyone's Settings/import
  // uses it. Same tenant only.
  const { data: me } = await admin.from("users").select("tenant_id").eq("id", userId).maybeSingle();
  const tenantId = (me as { tenant_id?: string | null } | null)?.tenant_id;
  if (!tenantId) return mine;
  const { data: rows } = await admin.from("user_google_tokens").select(cols).eq("tenant_id", tenantId).ilike("scopes", "%apps.order%").limit(5);
  const hit = ((rows ?? []) as ConnRow[]).find((r) => needHasScope(need, r.scopes) && (r.refresh_token || r.access_token));
  return hit ?? mine;
}

type JwtLike = Record<string, unknown>;

/** The decoded Auth.js cookie for THIS user, plus which cookie name it came from. */
async function readAuthjsToken(userId: string): Promise<{ token: JwtLike; name: string; chunked: boolean } | null> {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) return null;
  const jar = await cookies();
  const header = jar.toString();
  if (!header) return null;
  for (const secureCookie of [true, false]) {
    const name = secureCookie ? COOKIE_NAMES.secure : COOKIE_NAMES.plain;
    const t = await getToken({ req: { headers: { cookie: header } }, secret, secureCookie }).catch(() => null);
    if (!t) continue;
    if (t.uid !== userId) return null;
    return { token: t as JwtLike, name, chunked: !jar.get(name) };
  }
  return null;
}

/**
 * The usable Google token for `need`, or why there is none. `userId` must be the user
 * `supabase.auth.getUser()` verified for this request.
 */
export async function getGoogleAccessToken(need: GoogleNeed, userId: string): Promise<GoogleTokenResult> {
  let connOwner: string | null = null;
  let connStoredRefresh: string | null = null;
  let jwt: { token: JwtLike; name: string; chunked: boolean } | null = null;
  const provider = authProvider();

  return resolveGoogleToken(need, {
    now: () => Date.now(),
    canRefresh: () => Boolean(googleOAuthCreds() ?? authjsGoogleCreds()),
    hasScope: needHasScope,

    async readConnection(): Promise<StoredConnection | null> {
      const row = await readConnectionRow(need, userId);
      if (!row) return null;
      connOwner = row.user_id;
      connStoredRefresh = row.refresh_token;
      return {
        accessToken: row.access_token,
        refreshToken: row.refresh_token,
        expiresAt: row.token_expiry ? Date.parse(row.token_expiry) || 0 : 0,
        scopes: row.scopes,
      };
    },
    async refreshConnection(stored): Promise<Refreshed> {
      const creds = googleOAuthCreds();
      if (!creds) throw new Error("Google OAuth not configured");
      const r = await refreshAccessToken(stored, creds);
      return { accessToken: r.access_token, expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000, scope: r.scope ?? null };
    },
    async saveConnection(r) {
      if (!connOwner) return;
      await createAdminClient().from("user_google_tokens").update({
        access_token: r.accessToken,
        token_expiry: new Date(r.expiresAt).toISOString(),
        ...resealIfPlain(connStoredRefresh),
      }).eq("user_id", connOwner);
    },

    async readSession(): Promise<SessionGoogle | null> {
      if (provider === "authjs") {
        jwt = await readAuthjsToken(userId);
        if (!jwt) return null;
        const t = jwt.token;
        return {
          accessToken: typeof t.gat === "string" ? t.gat : null,
          refreshToken: typeof t.grt === "string" ? t.grt : null,
          expiresAt: typeof t.gexp === "number" ? t.gexp * 1000 : 0,
          scopes: typeof t.gscope === "string" ? t.gscope : LOGIN_SCOPES,
          scopesKnown: true,
        };
      }
      // GoTrue: Supabase keeps the provider token in its own session; no refresh token, no scopes.
      const { data: { session } } = await createClient().auth.getSession();
      const pt = (session as { provider_token?: string | null } | null)?.provider_token ?? null;
      return pt ? { accessToken: pt, refreshToken: null, expiresAt: 0, scopes: null, scopesKnown: false } : null;
    },
    async refreshSession(grt): Promise<Refreshed> {
      const creds = authjsGoogleCreds();
      if (!creds) throw new Error("Google sign-in not configured");
      const r = await refreshAccessToken(grt, creds);
      return { accessToken: r.access_token, expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000, scope: r.scope ?? null };
    },
    async saveSession(r) {
      // Write the refreshed token back into the SAME encrypted cookie, so the next request does
      // not refresh again. A chunked cookie (very large session) is left alone — then we simply
      // refresh once per request until the next sign-in.
      const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
      if (!jwt || jwt.chunked || !secret) return;
      const next: JwtLike = { ...jwt.token, gat: r.accessToken, gexp: Math.floor(r.expiresAt / 1000) };
      if (r.scope) next.gscope = r.scope;
      const value = await encode({ token: next, secret, salt: jwt.name, maxAge: SESSION_MAX_AGE });
      (await cookies()).set(jwt.name, value, {
        httpOnly: true, sameSite: "lax", path: "/", secure: jwt.name.startsWith("__Secure-"), maxAge: SESSION_MAX_AGE,
      });
    },
  });
}
