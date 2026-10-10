/**
 * TOTP (RFC 6238) — the 6-digit codes from Google Authenticator / Authy — with node:crypto only.
 * Same parameters GoTrue used (SHA-1, 6 digits, 30-second step), so a factor enrolled under
 * GoTrue keeps working after the switch to Auth.js, and back.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("invalid base32 secret");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32 — what authenticator apps expect. */
export function newSecret(): string {
  return base32Encode(randomBytes(20));
}

export function stepAt(ms: number): number {
  return Math.floor(ms / 1000 / STEP_SECONDS);
}

export function codeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

/**
 * The step a code belongs to, accepting one step of clock drift either side — or null.
 * The caller stores the step and refuses it next time, so a code cannot be replayed.
 */
export function matchStep(secret: string, code: string, nowMs = Date.now(), window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = stepAt(nowMs);
  for (let d = -window; d <= window; d++) {
    const expected = Buffer.from(codeAt(secret, now + d));
    if (timingSafeEqual(expected, Buffer.from(code))) return now + d;
  }
  return null;
}

export function otpauthUri(secret: string, account: string, issuer = "ResellerOS"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}
