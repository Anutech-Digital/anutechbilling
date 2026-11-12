import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { LINKEDIN_STATE_TTL_MS } from "./config";

type Payload = { t: string; u: string; n: string; e: number };
const b64 = (value: Buffer) => value.toString("base64url");
const signature = (body: string, key: string) => b64(createHmac("sha256", key).update(body).digest());

export const linkedInNonce = () => b64(randomBytes(18));

export function signLinkedInState(input: { tenantId: string; userId: string; nonce: string }, key: string, now = Date.now()): string {
  const body = b64(Buffer.from(JSON.stringify({ t: input.tenantId, u: input.userId, n: input.nonce, e: now + LINKEDIN_STATE_TTL_MS } satisfies Payload)));
  return `${body}.${signature(body, key)}`;
}

/** State is signed and tied to both the active person and their tenant. */
export function validLinkedInState(state: string | null, key: string, expect: { tenantId: string; userId: string; nonce?: string }, now = Date.now()): boolean {
  if (!state) return false;
  const [body, sig, extra] = state.split(".");
  if (!body || !sig || extra) return false;
  const wanted = Buffer.from(signature(body, key));
  const supplied = Buffer.from(sig);
  if (wanted.length !== supplied.length || !timingSafeEqual(wanted, supplied)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
    return parsed.e >= now && parsed.t === expect.tenantId && parsed.u === expect.userId && parsed.n === expect.nonce;
  } catch {
    return false;
  }
}
