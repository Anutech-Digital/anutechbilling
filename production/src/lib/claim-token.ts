/**
 * Signed tenant token for the public expense-claim link (/expense-claim).
 *
 * The link is opened with NO login, so it carries the tenant id + an HMAC
 * signature. The server recomputes the signature and constant-time compares —
 * a tampered/guessed tenant id won't verify. The employee's attendance PIN is
 * the real second factor (R-725: counted + locked in the DB, claim-pin-guard.ts),
 * and every claim lands 'pending' (owner approves).
 *
 * Secret: PDF_SIGNING_SECRET, else the service-role key — lib/security/signing-secrets.ts.
 * S20 (28 Sep 2026): verify also accepts the old service-role key during the grace window.
 *
 * R-725 (11 Oct 2026): links now EXPIRE. A new link carries `exp` (unix seconds) and the
 * signature covers it, so it cannot be stretched. Window: CLAIM_LINK_TTL_DAYS (90 days) —
 * the owner shares the link once with staff, so it must outlive a few pay cycles, but a link
 * that leaked to an ex-employee's phone must not work forever. The owner gets a fresh one
 * from the same screen whenever he opens it.
 *
 * Old links (no `exp`) keep working until LEGACY_CLAIM_LINKS_UNTIL so links already on
 * employees' phones do not all break at deploy; after that they show the plain
 * "link has expired, ask the office" message.
 */
import { createHmac, timingSafeEqual } from "crypto";
import { signingSecrets } from "@/lib/security/signing-secrets";

export const CLAIM_LINK_TTL_DAYS = 90;
/** Links made before R-725 had no expiry; they stop working after this moment. */
export const LEGACY_CLAIM_LINKS_UNTIL = "2026-11-15T18:30:00Z";

export const CLAIM_LINK_INVALID = "This link is invalid. Please ask the office for a fresh link.";
export const CLAIM_LINK_EXPIRED = "This link has expired. Please ask the office for a fresh link.";

const sign = (secret: string, tenantId: string, exp?: string) =>
  createHmac("sha256", secret)
    .update(exp ? `expense-claim:${tenantId}:${exp}` : `expense-claim:${tenantId}`)
    .digest("hex");

/** New-style signature for `tenantId` valid until `exp` (unix seconds, as a string). */
export function signClaimToken(tenantId: string, exp: string): string {
  return sign(signingSecrets().primary, tenantId, exp);
}

/** Expiry for a link made now. */
export function claimLinkExp(now: Date = new Date()): string {
  return String(Math.floor(now.getTime() / 1000) + CLAIM_LINK_TTL_DAYS * 86_400);
}

export type ClaimTokenStatus = "ok" | "invalid" | "expired";

export function claimTokenStatus(
  tenantId: string,
  sig: string,
  exp?: string | null,
  now: Date = new Date(),
): ClaimTokenStatus {
  if (!tenantId || !sig) return "invalid";
  const e = (exp ?? "").trim();
  if (e && !/^\d{9,11}$/.test(e)) return "invalid";
  const { primary, legacy } = signingSecrets();
  const b = Buffer.from(sig, "utf8");
  const signed = [primary, ...legacy].some((s) => {
    const a = Buffer.from(sign(s, tenantId, e || undefined), "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  });
  if (!signed) return "invalid";
  const until = e ? Number(e) * 1000 : new Date(LEGACY_CLAIM_LINKS_UNTIL).getTime();
  return now.getTime() < until ? "ok" : "expired";
}

export function verifyClaimToken(tenantId: string, sig: string, exp?: string | null): boolean {
  return claimTokenStatus(tenantId, sig, exp) === "ok";
}

/** Plain-English message for a link that did not pass. */
export function claimTokenError(status: ClaimTokenStatus): string {
  return status === "expired" ? CLAIM_LINK_EXPIRED : CLAIM_LINK_INVALID;
}

/** Full shareable claim link for a tenant (valid CLAIM_LINK_TTL_DAYS from now). */
export function claimLinkUrl(appUrl: string, tenantId: string, now: Date = new Date()): string {
  const base = appUrl.replace(/\/$/, "");
  const exp = claimLinkExp(now);
  return `${base}/expense-claim?tid=${encodeURIComponent(tenantId)}&exp=${exp}&sig=${signClaimToken(tenantId, exp)}`;
}
