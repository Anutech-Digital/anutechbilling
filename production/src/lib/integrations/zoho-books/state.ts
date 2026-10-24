/**
 * R-1749 — the OAuth `state`, signed and tied to one tenant + one user.
 *
 * state = base64url(JSON {t: tenantId, u: userId, n: nonce, e: expiresAtMs}) + "." + HMAC-SHA256.
 * The HMAC key is the server's Zoho client secret (server-only), so nobody can forge a state
 * that names another tenant. The callback additionally requires:
 *   - the nonce to equal the httpOnly cookie set when the connect started (CSRF), and
 *   - the signed tenant + user to equal the person signed in NOW.
 * So a code obtained by one tenant can never be stored on another tenant's row.
 *
 * Server-only (node:crypto).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { STATE_TTL_MS } from "./config";

export interface ZohoStatePayload { t: string; u: string; n: string; e: number }

const b64url = (b: Buffer) => b.toString("base64url");

function sign(body: string, key: string): string {
  return b64url(createHmac("sha256", key).update(body).digest());
}

export function newNonce(): string {
  return b64url(randomBytes(18));
}

export function signState(
  p: { tenantId: string; userId: string; nonce: string },
  key: string,
  now = Date.now(),
): string {
  const payload: ZohoStatePayload = { t: p.tenantId, u: p.userId, n: p.nonce, e: now + STATE_TTL_MS };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${body}.${sign(body, key)}`;
}

export type StateCheck =
  | { ok: true; payload: ZohoStatePayload }
  | { ok: false; reason: "missing" | "malformed" | "signature" | "expired" | "nonce" | "tenant" | "user" };

/**
 * Verify a state from the callback against the cookie nonce and the current session.
 * Every failure is a refusal — there is no "close enough".
 */
export function verifyState(
  state: string | null | undefined,
  key: string,
  expect: { nonce: string | null | undefined; tenantId: string; userId: string },
  now = Date.now(),
): StateCheck {
  if (!state) return { ok: false, reason: "missing" };
  const dot = state.indexOf(".");
  if (dot <= 0 || dot !== state.lastIndexOf(".")) return { ok: false, reason: "malformed" };
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const want = Buffer.from(sign(body, key));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: "signature" };

  let payload: ZohoStatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ZohoStatePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!payload || typeof payload.e !== "number" || typeof payload.n !== "string") return { ok: false, reason: "malformed" };
  if (now > payload.e) return { ok: false, reason: "expired" };
  if (!expect.nonce || expect.nonce !== payload.n) return { ok: false, reason: "nonce" };
  if (payload.t !== expect.tenantId) return { ok: false, reason: "tenant" };
  if (payload.u !== expect.userId) return { ok: false, reason: "user" };
  return { ok: true, payload };
}
