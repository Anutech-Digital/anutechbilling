/**
 * R-528 — what the BROWSER may see of an Auth.js session.
 *
 * GET /api/auth/session (and useSession / auth()) all go through the `session` callback, so
 * whatever it returns reaches the browser. The encrypted JWT cookie also holds the Google
 * access/refresh tokens (gat/grt, for Contacts / Reseller import); those stay in the cookie and
 * are read on the server only (compat.ts → currentProviderToken). This builds the session from
 * an allow-list — never by spreading the token — so a new JWT field can never leak by accident.
 */

export interface PublicSession {
  expires: string;
  user: { id: string; email: string; name: string | null; image: string | null };
  aal: "aal1" | "aal2";
  mfaEnrolled: boolean;
}

interface TokenLike {
  uid?: unknown;
  email?: unknown;
  aal?: unknown;
  mfa?: unknown;
  [k: string]: unknown;
}

interface SessionLike {
  expires?: unknown;
  user?: { name?: unknown; image?: unknown } | null;
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

export function publicSession(session: SessionLike, token: TokenLike): PublicSession {
  return {
    expires: str(session.expires) ?? new Date(0).toISOString(),
    user: {
      id: str(token.uid) ?? "",
      email: str(token.email) ?? "",
      name: str(session.user?.name),
      image: str(session.user?.image),
    },
    aal: token.aal === "aal2" ? "aal2" : "aal1",
    mfaEnrolled: Boolean(token.mfa),
  };
}
