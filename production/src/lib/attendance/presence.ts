/**
 * Rotating "office presence code" — server-only.
 *
 * The single most practical browser proof that an employee is physically at the
 * office: a 6-digit code that rotates every PRESENCE_WINDOW_SEC, shown on the
 * office tablet (kiosk). To self check-in from a personal phone (when the tenant
 * requires presence), the employee must type the CURRENT code — which they can
 * only read if they're in the room. The seed (presence_secret) never leaves the
 * server; only the derived code is ever exposed.
 */
import crypto from "node:crypto";

export const PRESENCE_WINDOW_SEC = 45;

/**
 * HMAC-derived 6-digit code for a given time window (TOTP-style truncation).
 *
 * R-440: the database has an exact twin, public.presence_code_at(secret, window), which
 * validate_presence_code() uses to check self check-in codes (current + previous window)
 * without the seed leaving the database. The kiosk shows THIS function's code, so the two
 * must never drift — presence.test.ts and supabase/tests/attendance_presence_code.test.sql
 * pin the same vectors.
 */
export function presenceCode(secret: string, windowIndex: number): string {
  const h = crypto.createHmac("sha256", secret).update(String(windowIndex)).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin =
    ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

export function currentWindow(nowMs: number): number {
  return Math.floor(nowMs / 1000 / PRESENCE_WINDOW_SEC);
}

/** Seconds until the current code rolls over. */
export function secondsRemaining(nowMs: number): number {
  return PRESENCE_WINDOW_SEC - (Math.floor(nowMs / 1000) % PRESENCE_WINDOW_SEC);
}

/** A fresh random seed for a tenant that doesn't have one yet. */
export function newPresenceSecret(): string {
  return crypto.randomBytes(24).toString("hex");
}
