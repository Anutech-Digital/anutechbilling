/**
 * Unsubscribe links for campaign email.
 *
 * Every campaign mail carries a link that, once confirmed, adds the address to
 * `email_suppressions` (migration 20260926190000); /api/campaigns/send then skips it.
 * Bulk marketing mail without an opt-out is what the IT Rules / DPDP consent language and
 * every mailbox provider's bulk-sender rules forbid — and a campaign with no way out gets
 * marked as spam, which is worse for the sending domain than an unsubscribe.
 *
 * The link is signed (HMAC over tenant + email) so nobody can unsubscribe someone else by
 * editing the URL, and no table of tokens has to be kept. Same secret discipline as
 * lib/pdf/pdf-token.ts: a dedicated UNSUBSCRIBE_SIGNING_SECRET if set, else the
 * service-role key, and never an empty key.
 *
 * Server-only: imports node:crypto.
 */
import { createHmac, timingSafeEqual } from "crypto";

function secret(): string {
  const s = process.env.UNSUBSCRIBE_SIGNING_SECRET?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!s) throw new Error("No signing secret: set UNSUBSCRIBE_SIGNING_SECRET (or SUPABASE_SERVICE_ROLE_KEY)");
  return s;
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function signUnsubscribe(tenantId: string, email: string): string {
  return createHmac("sha256", secret())
    .update(`unsubscribe:${tenantId}:${normaliseEmail(email)}`)
    .digest("hex")
    .slice(0, 32);
}

export function verifyUnsubscribe(tenantId: string, email: string, sig: string): boolean {
  if (!tenantId || !email || !sig) return false;
  const a = Buffer.from(signUnsubscribe(tenantId, email), "utf8");
  const b = Buffer.from(sig, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Absolute link for a mail, or null when there is no usable host (see quotes/accept-link.ts). */
export function unsubscribeUrl(appUrl: string | null | undefined, tenantId: string, email: string, campaignId?: string): string | null {
  const base = (appUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/i.test(base)) return null;
  const q = new URLSearchParams({ t: tenantId, e: normaliseEmail(email), s: signUnsubscribe(tenantId, email) });
  if (campaignId) q.set("c", campaignId);
  return `${base}/unsubscribe?${q.toString()}`;
}

/** The footer appended to every campaign mail. Plain text and HTML. */
export function unsubscribeFooter(url: string, senderName: string): { text: string; html: string } {
  const safeName = senderName.replace(/[<>&"]/g, "");
  return {
    text: `\n\n—\nYe mail ${safeName} ki taraf se aaya hai. Aage aise mail nahi chahiye? Unsubscribe: ${url}`, // customer-language
    html: `<hr style="border:none;border-top:1px solid #ddd;margin:24px 0 12px"/>`
        + `<p style="font-size:12px;color:#777;margin:0">Ye mail ${safeName} ki taraf se aaya hai. ` // customer-language
        + `Aage aise mail nahi chahiye? <a href="${url.replace(/"/g, "&quot;")}" style="color:#777">Unsubscribe</a></p>`, // customer-language
  };
}
