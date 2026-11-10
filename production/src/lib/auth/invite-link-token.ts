/**
 * R-2517 — the single-use token in a cross-company invite email (proof of the invited MAILBOX).
 *
 * Team → Invite for a login that already works in another company makes a token here, stores ONLY
 * its sha256 (membership_invites.token_hash, via invite_existing_login) and puts the token itself
 * only in the email's link: /invites/accept#token=… . accept_company_invite_by_token hashes what
 * the link carries and must find that row AND the signed-in invited login. So whoever controls the
 * login alone (e.g. an owner who once set a temporary password for it) cannot accept.
 *
 * Server-only (node:crypto). Shape kept in step with public.r2517_token_hash (base64url, 32–128).
 */
import { createHash, randomBytes } from "node:crypto";

/** 32 random bytes → 43 base64url characters. */
const TOKEN_BYTES = 32;

export function hashInviteLinkToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newInviteLinkToken(): { token: string; hash: string } {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, hash: hashInviteLinkToken(token) };
}

/**
 * The link in the invite email. `base` is the trusted app origin (lib/app-url trustedOrigin).
 * The token is in the FRAGMENT (#token=…): a browser never sends it to the server, so it is not in
 * request logs, proxies or error-report URLs; the page reads it in the browser and POSTs it.
 */
export function inviteAcceptUrl(base: string, token: string): string {
  return `${base}/invites/accept#token=${encodeURIComponent(token)}`;
}
