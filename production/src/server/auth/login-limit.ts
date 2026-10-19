/**
 * R-1548 (18 Oct 2026): a limit on email+password guesses for the Auth.js login.
 *
 * Before this, POST /api/auth/callback/credentials → authorize() → checkPassword had no count at
 * all (GoTrue's own login limits went away with the Auth.js switch), so a password could be
 * guessed forever. The check runs INSIDE authorize(), before bcrypt — every way into the
 * Credentials provider passes through it, so it can't be skipped by calling another URL.
 *
 *   per email  10 tries / 15 min — from ANY IP (an attacker with many IPs still gets 10).
 *              The key carries the account's last_sign_in_at: a successful sign-in moves it,
 *              so the count starts again — this works on the shared Postgres counter too,
 *              which has no reset. Only the right password can move it.
 *   per IP     30 tries / 15 min — across emails (one IP spraying many accounts). Generous,
 *              because an office shares one IP.
 *
 * Time-boxed only: a locked email opens again by itself after the window — the real user is
 * never locked out for longer, and "Forgot password" still works meanwhile.
 * Counts go through rateLimitShared: one count across Cloud Run instances when
 * RATE_LIMIT_STORE=postgres (hashed keys — no raw email/IP in the DB), memory otherwise.
 */
import "server-only";
import { clientIp, rateLimitShared, type RateLimitResult } from "@/lib/security/rate-limit";

export const LOGIN_PER_EMAIL = { limit: 10, windowMs: 15 * 60_000 } as const;
export const LOGIN_PER_IP = { limit: 30, windowMs: 15 * 60_000 } as const;

type Hit = (key: string, opts: { limit: number; windowMs: number }) => Promise<RateLimitResult>;

/**
 * Count one login try. `false` = refuse it without checking the password.
 * `epoch` = the account's last sign-in time (null for none / unknown email).
 */
export async function loginAttemptAllowed(
  input: { email: string; headers: Headers | null | undefined; epoch: string | null },
  hit: Hit = rateLimitShared,
): Promise<boolean> {
  const ip = input.headers ? clientIp(input.headers) : "unknown";
  const byIp = await hit(`login-ip:${ip}`, LOGIN_PER_IP);
  if (!byIp.ok) return false;
  const email = input.email.trim().toLowerCase(); // same as accounts.normalise
  const byEmail = await hit(`login-email:${email}:${input.epoch ?? "never"}`, LOGIN_PER_EMAIL);
  return byEmail.ok;
}
