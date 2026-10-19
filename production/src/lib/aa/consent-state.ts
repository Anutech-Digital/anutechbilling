/**
 * R-879: the signed `state` that ties a Setu consent callback to ONE connection of ONE tenant.
 *
 * Before this, GET /api/aa/setu/callback?handle=… marked any connection whose handle you knew as
 * `active` (or `rejected` with approved=false) — no signature, no expiry. Now consent/init signs
 * `state = <exp>.<connectionId>.<hmac(aa-consent-state:v1:tenant:connection:exp)>` and puts it in
 * the redirect URL; the callback recomputes it from the row and refuses anything else.
 *
 * Key: the same capability-link key as PDF links (lib/security/signing-secrets.ts), separated by
 * the `aa-consent-state:v1` prefix so a PDF token can never verify here. Short life: 1 hour is
 * plenty to approve on the phone; an old link from browser history is refused.
 */
import { createHmac, timingSafeEqual } from "crypto";
import { signingSecrets } from "@/lib/security/signing-secrets";

export const CONSENT_STATE_TTL_SECONDS = 60 * 60;

const STATE_RE = /^(\d{9,11})\.([0-9a-f-]{36})\.([0-9a-f]{64})$/;

function mac(secret: string, tenantId: string, connectionId: string, exp: number): string {
  return createHmac("sha256", secret).update(`aa-consent-state:v1:${tenantId}:${connectionId}:${exp}`).digest("hex");
}

export function signConsentState(tenantId: string, connectionId: string, now: Date = new Date()): string {
  const exp = Math.floor(now.getTime() / 1000) + CONSENT_STATE_TTL_SECONDS;
  return `${exp}.${connectionId}.${mac(signingSecrets(now).primary, tenantId, connectionId, exp)}`;
}

/** The connection id a well-formed state names, before any DB read. null = not even shaped right. */
export function consentStateConnectionId(state: string | null | undefined): string | null {
  const m = STATE_RE.exec(state ?? "");
  return m ? m[2] : null;
}

export type ConsentStateVerdict = { ok: true } | { ok: false; reason: "malformed" | "expired" | "bad_signature" };

/** Verify `state` for this tenant + connection. Fails closed on any doubt. */
export function verifyConsentState(
  state: string | null | undefined,
  tenantId: string,
  connectionId: string,
  now: Date = new Date(),
): ConsentStateVerdict {
  const m = STATE_RE.exec(state ?? "");
  if (!m || !tenantId || m[2] !== connectionId) return { ok: false, reason: "malformed" };
  const exp = Number(m[1]);
  if (!Number.isFinite(exp) || exp * 1000 <= now.getTime()) return { ok: false, reason: "expired" };
  let secrets: string[];
  try {
    const s = signingSecrets(now);
    secrets = [s.primary, ...s.legacy];
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  const given = Buffer.from(m[3], "utf8");
  for (const secret of secrets) {
    const want = Buffer.from(mac(secret, tenantId, connectionId, exp), "utf8");
    if (want.length === given.length && timingSafeEqual(want, given)) return { ok: true };
  }
  return { ok: false, reason: "bad_signature" };
}
