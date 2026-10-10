/**
 * Password reset links, replacing GoTrue's resetPasswordForEmail.
 *
 * The raw token only ever exists in the email; the database keeps its SHA-256 in
 * auth.users.recovery_token (the column GoTrue used for the same job). A token works once and
 * for one hour. Asking for a link never reveals whether an account exists.
 */
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { withAuthStore } from "@/server/db/auth-store";
import { sendEmail } from "@/lib/email/send";
import { normalise, updateUser } from "./accounts";

const TTL_MINUTES = 60;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

export async function sendRecoveryLink(email: string, origin: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const rows = await withAuthStore((tx) => tx.$queryRawUnsafe<{ id: string; email: string }[]>(
    `update auth.users set recovery_token = $2, recovery_sent_at = now()
      where id = (select id from auth.users where lower(email) = $1 and deleted_at is null order by created_at limit 1)
      returning id::text as id, email`, normalise(email), sha256(token)));
  if (!rows[0]) return; // same outward answer either way
  const link = `${origin.replace(/\/+$/, "")}/reset-password?token=${encodeURIComponent(token)}`;
  await sendEmail({
    to: rows[0].email,
    subject: "Reset your ResellerOS password",
    text: `Someone asked to reset the password for this account.\n\nChoose a new password: ${link}\n\nThe link works once, for ${TTL_MINUTES} minutes. If it was not you, ignore this email — nothing changes.`,
    html: `<p>Someone asked to reset the password for this account.</p><p><a href="${escapeHtml(link)}">Choose a new password</a></p><p>The link works once, for ${TTL_MINUTES} minutes. If it was not you, ignore this email — nothing changes.</p>`,
    kind: "password_reset",
  });
}

/** Spend a reset token: sets the new password and returns the account email, or null if the link is bad/old/used. */
export async function resetWithToken(token: string, newPassword: string): Promise<string | null> {
  if (!token || token.length < 20) return null;
  const rows = await withAuthStore((tx) => tx.$queryRawUnsafe<{ id: string; email: string }[]>(
    `update auth.users set recovery_token = '', recovery_sent_at = null
      where recovery_token = $1 and recovery_sent_at > now() - make_interval(mins => $2)
      returning id::text as id, email`, sha256(token), TTL_MINUTES));
  if (!rows[0]) return null;
  // A reset link also proves the mailbox.
  await updateUser(rows[0].id, { password: newPassword, email_confirm: true });
  return rows[0].email;
}
