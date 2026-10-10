/**
 * R-824 — which Google access token a Google API route may use, and why not when there is none.
 *
 * Pure logic (no cookies, DB or fetch) so it is tested on its own; ./google-token.ts wires it to
 * the real stores. The TOKEN never leaves the server: callers put it in an Authorization header
 * to Google and return only a `reason` to the browser (R-528).
 *
 * Order, first usable wins:
 *   1. The saved connection (`user_google_tokens`, "Connect Google Reseller" / "Connect Google
 *      Contacts") — it carries a refresh token and its granted scopes, so it survives sign-out and
 *      works for password logins. Refreshed here when it is within a minute of expiring.
 *   2. The sign-in session:
 *        authjs → the Google tokens in the encrypted Auth.js cookie (gat / grt / gexp / gscope),
 *                 refreshed with grt and written back to the cookie.
 *        gotrue → Supabase's provider_token (no refresh token, no scope list — Google decides).
 *
 * When nothing works, the reason is the most useful one for the person:
 *   needs_reauth   a token existed but Google refused to refresh it (revoked / expired grant)
 *   missing_scope  Google is connected, but without the permission this feature needs
 *   not_connected  no Google token at all (password login, never connected)
 *   not_configured the server has no Google OAuth client to refresh with
 */

export type GoogleNeed = "reseller" | "contacts";

export type GoogleTokenReason = "not_connected" | "missing_scope" | "needs_reauth" | "not_configured";

export type GoogleTokenResult =
  | { ok: true; token: string; source: "connection" | "session" }
  | { ok: false; reason: GoogleTokenReason };

/** A saved connection row, as read server-side. The refresh token is the stored (sealed) value. */
export interface StoredConnection {
  accessToken: string | null;
  refreshToken: string | null;
  /** ms since epoch, 0 when unknown */
  expiresAt: number;
  scopes: string | null;
}

/** The Google part of the sign-in session. Auth.js has refresh + scopes; GoTrue has neither. */
export interface SessionGoogle {
  accessToken: string | null;
  refreshToken: string | null;
  /** ms since epoch, 0 when unknown */
  expiresAt: number;
  /** null = this provider does not tell us (GoTrue) — let Google decide */
  scopes: string | null;
  scopesKnown: boolean;
}

export interface Refreshed { accessToken: string; expiresAt: number; scope?: string | null }

export interface GoogleTokenDeps {
  now(): number;
  readConnection(): Promise<StoredConnection | null>;
  /** Trade the stored refresh token for a new access token; throws when Google refuses. */
  refreshConnection(refreshToken: string): Promise<Refreshed>;
  saveConnection(r: Refreshed): Promise<void>;
  readSession(): Promise<SessionGoogle | null>;
  refreshSession(refreshToken: string): Promise<Refreshed>;
  saveSession(r: Refreshed): Promise<void>;
  /** Does `scopes` carry what `need` requires? */
  hasScope(need: GoogleNeed, scopes: string | null): boolean;
  /** false when the server has no OAuth client id/secret (refresh impossible). */
  canRefresh(): boolean;
}

/** Refresh a minute early so a token never expires between this check and Google's. */
export const EARLY_REFRESH_MS = 60_000;

const RANK: Record<GoogleTokenReason, number> = { not_connected: 0, not_configured: 1, missing_scope: 2, needs_reauth: 3 };
const worse = (a: GoogleTokenReason, b: GoogleTokenReason) => (RANK[b] > RANK[a] ? b : a);

export async function resolveGoogleToken(need: GoogleNeed, d: GoogleTokenDeps): Promise<GoogleTokenResult> {
  let reason: GoogleTokenReason = "not_connected";

  // 1 — the saved connection
  const conn = await d.readConnection().catch(() => null);
  if (conn && (conn.accessToken || conn.refreshToken)) {
    if (!d.hasScope(need, conn.scopes)) {
      reason = worse(reason, "missing_scope");
    } else if (conn.accessToken && conn.expiresAt > d.now() + EARLY_REFRESH_MS) {
      return { ok: true, token: conn.accessToken, source: "connection" };
    } else if (!conn.refreshToken) {
      reason = worse(reason, "needs_reauth");
    } else if (!d.canRefresh()) {
      reason = worse(reason, "not_configured");
    } else {
      try {
        const r = await d.refreshConnection(conn.refreshToken);
        await d.saveConnection(r).catch(() => undefined); // a failed save only costs a refresh next time
        return { ok: true, token: r.accessToken, source: "connection" };
      } catch {
        reason = worse(reason, "needs_reauth");
      }
    }
  }

  // 2 — the sign-in session
  const s = await d.readSession().catch(() => null);
  if (s && (s.accessToken || s.refreshToken)) {
    if (s.scopesKnown && !d.hasScope(need, s.scopes)) {
      reason = worse(reason, "missing_scope");
    } else if (s.accessToken && (s.expiresAt === 0 ? !s.scopesKnown : s.expiresAt > d.now() + EARLY_REFRESH_MS)) {
      // GoTrue gives no expiry: hand the token over and let Google answer.
      return { ok: true, token: s.accessToken, source: "session" };
    } else if (!s.refreshToken) {
      reason = worse(reason, "needs_reauth");
    } else if (!d.canRefresh()) {
      reason = worse(reason, "not_configured");
    } else {
      try {
        const r = await d.refreshSession(s.refreshToken);
        await d.saveSession(r).catch(() => undefined);
        return { ok: true, token: r.accessToken, source: "session" };
      } catch {
        reason = worse(reason, "needs_reauth");
      }
    }
  }

  return { ok: false, reason };
}

/**
 * Google's answer to an API call, as one of our reasons. `null` = not an auth/setup problem
 * (the route reports it as an upstream error instead).
 */
export function classifyGoogleApiError(status: number, body: string): "api_disabled" | "missing_scope" | "needs_reauth" | null {
  if (status === 403 && /(accessNotConfigured|has not been used|is disabled|SERVICE_DISABLED)/i.test(body)) return "api_disabled";
  if (status === 403 && /(ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient.?scope|insufficientPermissions)/i.test(body)) return "missing_scope";
  if (status === 401 || status === 403) return "needs_reauth";
  return null;
}

/** Plain-English text for each reason, per feature — what the Settings card and toasts show. */
export function googleReasonMessage(need: GoogleNeed, reason: GoogleTokenReason | "api_disabled"): string {
  if (need === "reseller") {
    switch (reason) {
      case "not_connected":
      case "missing_scope": return "Connect Google Reseller to see subscriptions";
      case "needs_reauth": return "Google needs you to sign in again";
      case "api_disabled": return "The Reseller API is turned off in Google Cloud";
      case "not_configured": return "Google sign-in is not set up on this server";
    }
  }
  switch (reason) {
    case "not_connected":
    case "missing_scope": return "Connect Google Contacts to import contacts";
    case "needs_reauth": return "Google needs you to sign in again";
    case "api_disabled": return "The People API is turned off in Google Cloud";
    case "not_configured": return "Google sign-in is not set up on this server";
  }
}
