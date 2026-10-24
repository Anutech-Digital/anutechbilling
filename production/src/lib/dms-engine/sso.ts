/**
 * Minting the hand-off token that signs a user into DMS.
 *
 * ─── WHAT THIS TOKEN IS ALLOWED TO SAY ───────────────────────────────────────
 * An email address, and nothing else that matters. Not a role, not a
 * permission, not a tenant. DMS looks the email up in its OWN user collection
 * and decides what that person may do there.
 *
 * That asymmetry is deliberate and worth keeping: an "owner" here is not an
 * admin there, the two permission models will drift, and a token that could
 * assert a role would turn this shared secret into a privilege-escalation
 * primitive against the other application.
 *
 * R-1771 (22 Oct 2026): it may also carry `billing_customer_id` — the ResellerOS
 * customer the signed-in person is a customer login of (the id /api/v1 answers
 * to). It is a link hint, not a grant: DMS still signs in by email and decides
 * permissions itself; it only records which ResellerOS customer that user is.
 * The caller must derive it from the session user, never from the request.
 *
 * ─── SHORT, SINGLE-USE, AND ITS OWN SECRET ───────────────────────────────────
 * The token travels in a URL, so it will land in browser history and proxy
 * logs. It lasts 60 seconds, carries a random `jti` that DMS burns on first
 * use, and is signed with DMS_SSO_SECRET — separate from anything Supabase
 * uses, because this one is shared with a second application and is therefore
 * the most likely of our secrets to leak.
 *
 * ─── FAIL CLOSED ─────────────────────────────────────────────────────────────
 * No secret configured means no link is offered. It must never fall back to an
 * unsigned or default-signed token.
 */
import "server-only";
import crypto from "node:crypto";

/**
 * HS256 signing by hand, rather than adding `jsonwebtoken` to this app.
 *
 * The asymmetry is the justification: VERIFYING a JWT is where the dangerous
 * parsing lives — algorithm confusion, `alg: none`, segment handling — and DMS
 * does that with the real library. SIGNING is the easy direction. We control
 * every input, there is nothing to parse, and the whole operation is one HMAC.
 * A dependency added to a 90-package app to avoid ten lines of crypto is not a
 * trade worth making.
 */
function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signHs256(payload: Record<string, unknown>, secret: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

const SSO_SECRET = (process.env.DMS_SSO_SECRET ?? "").trim();
const BASE_URL = (process.env.DMS_ENGINE_URL ?? "").trim().replace(/\/+$/, "");

/** Matches MAX_AGE_SECONDS on the DMS side. Long enough for a redirect, no longer. */
const TTL_SECONDS = 60;

export function isSsoConfigured(): boolean {
  return SSO_SECRET.length > 0 && BASE_URL.length > 0;
}

/**
 * Build the URL that signs `email` into DMS and drops them on `next`.
 *
 * Returns null when SSO is not configured, so callers render a plain link to
 * DMS instead of a broken one.
 *
 * `next` is a path within DMS, never a full URL — DMS passes it to NextAuth as
 * a callbackUrl, which rejects anything off-origin, but sending only a path
 * means a caller here cannot even attempt it.
 */
export function buildSsoUrl(
  email: string,
  opts: { next?: string; sourceUserId?: string; billingCustomerId?: string } = {}
): string | null {
  if (!isSsoConfigured()) return null;

  const next = opts.next ?? "/admin";
  if (!next.startsWith("/")) {
    throw new Error(`SSO 'next' must be a path within DMS, got: ${next}`);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = signHs256(
    {
      email: email.trim().toLowerCase(),
      purpose: "engine-sso",
      // Random per mint. DMS stores it once in Redis, so a replay of this exact
      // token is refused even inside its 60-second window.
      jti: crypto.randomBytes(16).toString("hex"),
      // For log correlation on the far side only. DMS never authorises on it.
      ...(opts.sourceUserId ? { sub: opts.sourceUserId } : {}),
      // R-1771: which ResellerOS customer this login belongs to, so DMS links its
      // user by ID instead of only by email. Absent for staff and when unsure.
      ...(opts.billingCustomerId ? { billing_customer_id: opts.billingCustomerId } : {}),
      // `iat` is not decoration: DMS verifies with `maxAge`, which is measured
      // from this claim. Omit it and the far side rejects every token.
      iat: nowSeconds,
      exp: nowSeconds + TTL_SECONDS,
    },
    SSO_SECRET
  );

  const url = new URL(`${BASE_URL}/sso`);
  url.searchParams.set("token", token);
  url.searchParams.set("next", next);
  return url.toString();
}
