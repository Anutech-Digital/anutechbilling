/**
 * R-1903: a 6-digit one-time code and its hash. The database only ever sees the hash
 * (public.phone_otps.code_hash) — HMAC-SHA256 with a server secret over user + number + code,
 * so a copied table cannot be turned back into codes, and one user's code never matches
 * another user's row.
 */
import "server-only";
import { createHmac, randomInt } from "node:crypto";
import { isProductionDeployment } from "@/lib/checkout/live-guards";

type Env = Record<string, string | undefined>;

export const OTP_LENGTH = 6;

export function generateOtp(): string {
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");
}

export function isOtpShape(code: unknown): code is string {
  return typeof code === "string" && /^\d{6}$/.test(code);
}

/**
 * The HMAC key: a dedicated OTP_HASH_SECRET, else the server's existing secrets. Off a
 * deployment (dev:local blanks most keys) a fixed local key is fine — nothing real is protected
 * there. On a deployment with none of them: null → the routes say "not set up".
 */
export function otpHashSecret(env: Env = process.env): string | null {
  const s = env.OTP_HASH_SECRET || env.AUTH_SECRET || env.NEXTAUTH_SECRET || env.SUPABASE_SERVICE_ROLE_KEY;
  if (s) return s;
  return isProductionDeployment(env) ? null : "r1903-local-dev-otp-key";
}

export function hashOtp(secret: string, userId: string, phone: string, code: string): string {
  return createHmac("sha256", secret).update(`r1903:${userId}:${phone}:${code}`).digest("hex");
}

/** The SMS text (slice 3's DLT template must match it word for word). */
export function otpSmsText(code: string): string {
  return `${code} is your ResellerOS OTP to verify your mobile number. Valid 5 min. Do not share. - Anutech`;
}
