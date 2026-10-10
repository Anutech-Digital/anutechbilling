/**
 * Email verification for password signups (R-048, 4 Oct 2026).
 *
 * The signup route creates the auth user UNCONFIRMED, then calls `startEmailVerification`,
 * which stores the SHA-256 of a random token and emails the link. `confirmEmailToken`
 * checks the token and confirms the user through the admin API. GoTrue refuses a password
 * sign-in for an unconfirmed user, so the account cannot be used until the link is followed.
 *
 * Why our own token and not GoTrue's mailer link: see migration 20261004100000.
 */
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/email/send";

/** How long a link works. Long enough for "I'll check my mail tomorrow". */
export const VERIFY_TTL_HOURS = 48;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** A fresh URL-safe token (32 random bytes). */
export const newToken = () => randomBytes(32).toString("base64url");

export function verifyLink(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/verify-email?token=${encodeURIComponent(token)}`;
}

export function verificationEmail(name: string, link: string): { subject: string; text: string; html: string } {
  const first = (name || "").trim().split(/\s+/)[0] || "there";
  const subject = "Confirm your email for ResellerOS";
  const text =
    `Hi ${first},\n\nPlease confirm this is your email address so you can sign in to ResellerOS:\n\n${link}\n\n` +
    `The link works for ${VERIFY_TTL_HOURS} hours. If you did not sign up, ignore this email — no account can be used without it.\n`;
  const safe = link.replace(/"/g, "&quot;");
  const html =
    `<p>Hi ${escapeHtml(first)},</p><p>Please confirm this is your email address so you can sign in to ResellerOS.</p>` +
    `<p><a href="${safe}" style="display:inline-block;padding:12px 20px;background:#1668E3;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Confirm my email</a></p>` +
    `<p style="color:#666;font-size:13px">The link works for ${VERIFY_TTL_HOURS} hours. If you did not sign up, ignore this email — no account can be used without it.</p>`;
  return { subject, text, html };
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

/** Store a new token for this user and email the link. Never throws; returns whether it sent. */
export async function startEmailVerification(
  admin: SupabaseClient,
  input: { userId: string; email: string; name: string; origin: string; now?: Date },
): Promise<{ sent: boolean; reason?: string }> {
  const token = newToken();
  const now = input.now ?? new Date();
  const { error } = await admin.from("email_verifications").insert({
    user_id: input.userId,
    email: input.email,
    token_hash: hashToken(token),
    expires_at: new Date(now.getTime() + VERIFY_TTL_HOURS * 3_600_000).toISOString(),
  });
  if (error) return { sent: false, reason: error.message };
  const mail = verificationEmail(input.name, verifyLink(input.origin, token));
  const res = await sendEmail({ to: input.email, ...mail, kind: "email_verification" });
  return res.status === "sent" ? { sent: true } : { sent: false, reason: res.errorMessage ?? res.status };
}

export type ConfirmResult =
  | { ok: true; email: string; userId?: string }
  | { ok: false; reason: "invalid" | "expired" | "used" | "error" };

/** Check a token and confirm its user's email. Single use. */
export async function confirmEmailToken(admin: SupabaseClient, token: string, now: Date = new Date()): Promise<ConfirmResult> {
  if (!token || token.length < 20 || token.length > 200) return { ok: false, reason: "invalid" };
  const { data: row, error } = await admin
    .from("email_verifications")
    .select("id, user_id, email, expires_at, used_at")
    .eq("token_hash", hashToken(token))
    .maybeSingle();
  if (error) return { ok: false, reason: "error" };
  if (!row) return { ok: false, reason: "invalid" };
  if (row.used_at) return { ok: false, reason: "used" };
  if (new Date(row.expires_at).getTime() < now.getTime()) return { ok: false, reason: "expired" };

  const { error: upErr } = await admin.auth.admin.updateUserById(row.user_id, { email_confirm: true });
  if (upErr) return { ok: false, reason: "error" };
  await admin.from("email_verifications").update({ used_at: now.toISOString() }).eq("id", row.id);
  return { ok: true, email: row.email, userId: row.user_id };
}
