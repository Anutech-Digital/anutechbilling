/**
 * Google review request — the message, and the rules about when to ask.
 *
 * Pure: shared by the email route (server) and the WhatsApp button (browser). The review
 * link is the Google Business Profile "ask for reviews" short link, saved on the Marketing
 * Hub's Google Business row (marketing_tools.review_link).
 */

/** A review link must be an absolute https URL — it goes into mail and WhatsApp as-is. */
export function isValidReviewLink(url: string | null | undefined): boolean {
  return /^https:\/\/[^\s/]+\.[^\s/]+\/?\S*$/i.test((url ?? "").trim());
}

/** Don't ask the same customer again within this many days. */
export const REVIEW_COOLDOWN_DAYS = 30;

export function daysSince(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}

/** True when the customer was asked recently enough that asking again would nag. */
export function tooSoon(lastAskedIso: string | null | undefined, now: Date = new Date()): boolean {
  const d = daysSince(lastAskedIso, now);
  return d !== null && d < REVIEW_COOLDOWN_DAYS;
}

export interface ReviewMessageInput {
  contactName: string | null | undefined;
  company: string | null | undefined;
  sender: string;
  link: string;
}

function firstName(n: string | null | undefined): string {
  return (n ?? "").trim().split(/\s+/)[0] || "there";
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function reviewEmail(i: ReviewMessageInput): { subject: string; text: string; html: string } {
  const name = firstName(i.contactName);
  const subject = `A quick favour, ${name}?`;
  const text =
    `Hi ${name},\n\n` +
    `Thank you for working with ${i.sender}${i.company ? ` on ${i.company}'s setup` : ""}. ` +
    `If you are happy with our work, a short Google review would mean a lot to us — it takes under a minute:\n\n` +
    `${i.link}\n\n` +
    `And if anything is not right, just reply to this mail and we will fix it first.\n\n` +
    `Thank you,\n${i.sender}`;
  const html =
    `<p>Hi ${esc(name)},</p>` +
    `<p>Thank you for working with ${esc(i.sender)}${i.company ? ` on ${esc(i.company)}'s setup` : ""}. ` +
    `If you are happy with our work, a short Google review would mean a lot to us — it takes under a minute.</p>` +
    `<p style="margin:20px 0"><a href="${esc(i.link)}" style="background:#c2410c;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Write a review</a></p>` +
    `<p>And if anything is not right, just reply to this mail and we will fix it first.</p>` +
    `<p>Thank you,<br>${esc(i.sender)}</p>`;
  return { subject, text, html };
}

export function reviewWhatsAppText(i: ReviewMessageInput): string {
  return `Namaste ${firstName(i.contactName)}, ${i.sender} ke saath kaam karne ke liye dhanyavaad! ` + // customer-language
    `Agar aap hamare kaam se khush hain to 1 minute nikaal kar Google par review de dijiye: ${i.link} ` + // customer-language
    `— aur kuch theek na laga ho to bataiye, pehle use theek karenge.`; // customer-language
}

/** wa.me click-to-chat link; a 10-digit Indian mobile gets 91. Null when there is no number. */
export function whatsAppLink(phone: string | null | undefined, text: string): string | null {
  const d = (phone ?? "").replace(/\D/g, "");
  if (d.length < 10) return null;
  const n = d.length === 10 ? `91${d}` : d.replace(/^0+/, "");
  return `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
}
