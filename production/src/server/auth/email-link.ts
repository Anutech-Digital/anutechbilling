/**
 * R-1926 (G-ONBOARD OB-5): the confirm link in the signup mail also signs the person in.
 *
 * /api/auth/verify-email spends the one-time email token FIRST (R-048, confirmEmailToken) and
 * only then calls startSessionAfterVerify — so a session is never made for an unverified
 * address or from a used / expired link. The session is for the token's own user id; which
 * tenant they see comes from their public.users row as on every other sign-in.
 *
 *  AUTH_PROVIDER=authjs (staging / live): a 60-second ticket, HMAC-SHA256 with AUTH_SECRET,
 *    is handed IN-PROCESS to the "email-link" Credentials provider (authjs.ts) through
 *    next-auth's server signIn, which sets the session cookie on this response. The ticket
 *    never reaches the browser; forging one needs AUTH_SECRET — the same key that signs the
 *    session cookie itself. authorize re-reads the account: confirmed, not banned.
 *  GoTrue (local Supabase): an admin magic link for the address (no mail is sent by
 *    generateLink) is spent at once with verifyOtp on the server client, which sets the
 *    Supabase cookies on this response.
 *
 * Best-effort: any failure returns false and the page falls back to "Sign in" — the email
 * stays confirmed either way.
 */
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

export const EMAIL_LINK_PROVIDER = "email-link";
const TICKET_TTL_MS = 60_000;
const PURPOSE = "R-1926:email-link:";

const sign = (payload: string, secret: string) =>
  createHmac("sha256", secret).update(PURPOSE + payload).digest("base64url");

export function mintEmailLinkTicket(userId: string, secret: string, now: Date = new Date()): string {
  if (!secret) throw new Error("AUTH_SECRET is not set");
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: now.getTime() + TICKET_TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** The user id a ticket names, or null when it is malformed, tampered, foreign or expired. */
export function readEmailLinkTicket(ticket: string, secret: string, now: Date = new Date()): string | null {
  if (!secret || typeof ticket !== "string" || ticket.length > 512) return null;
  const [payload, sig, extra] = ticket.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  const want = Buffer.from(sign(payload, secret));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { uid?: unknown; exp?: unknown };
    if (typeof p.uid !== "string" || !/^[0-9a-f-]{36}$/i.test(p.uid)) return null;
    if (typeof p.exp !== "number" || p.exp < now.getTime()) return null;
    return p.uid;
  } catch {
    return null;
  }
}

interface TicketUser {
  id: string;
  email: string;
  email_confirmed_at: string | null;
  banned_until?: string | null;
  user_metadata?: Record<string, unknown>;
}

/** The "email-link" provider's authorize: a valid ticket for a confirmed, active account. */
export async function authorizeEmailLink(
  ticket: unknown,
  deps: { secret: string; getUser: (id: string) => Promise<TicketUser | null>; now?: Date },
): Promise<{ id: string; email: string; name: string | null } | null> {
  const uid = readEmailLinkTicket(typeof ticket === "string" ? ticket : "", deps.secret, deps.now);
  if (!uid) return null;
  const u = await deps.getUser(uid);
  if (!u || !u.email || !u.email_confirmed_at) return null;
  if (u.banned_until && new Date(u.banned_until).getTime() > (deps.now ?? new Date()).getTime()) return null;
  return { id: u.id, email: u.email, name: (u.user_metadata?.full_name as string | undefined) ?? null };
}

export function authSecret(): string {
  return process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? "";
}

/** Sign the just-confirmed user in on this response. Never throws. */
export async function startSessionAfterVerify(input: { userId: string; email: string }): Promise<boolean> {
  try {
    const { authProvider, signIn } = await import("./authjs");
    if (authProvider() === "authjs") {
      const secret = authSecret();
      if (!secret) return false;
      // A refused ticket throws (raw mode: CredentialsSignin); an error URL is refused too.
      const url = await signIn(EMAIL_LINK_PROVIDER, { ticket: mintEmailLinkTicket(input.userId, secret), redirect: false });
      return !(typeof url === "string" && /[?&]error=/.test(url));
    }
    const { createAdminClient, createClient } = await import("@/lib/supabase/server");
    const { data, error } = await createAdminClient().auth.admin.generateLink({ type: "magiclink", email: input.email });
    const hashed = data?.properties?.hashed_token;
    if (error || !hashed) return false;
    const { error: otpErr } = await createClient().auth.verifyOtp({ token_hash: hashed, type: "magiclink" });
    return !otpErr;
  } catch (e) {
    console.warn("[verify-email] R-1926 session not started:", (e as Error).message);
    return false;
  }
}
