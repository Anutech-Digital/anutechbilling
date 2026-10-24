/* Contact comes from the site config, one place for the whole site (owner, 29 Sep 2026).
   Until then this page carried one person's phone and a retired-brand email address.
   While the site's WhatsApp number is still the placeholder, WHATSAPP_READY is false and
   the WhatsApp / call links are not shown: a dead button in front of somebody who has
   just paid is worse than an email address. Shared by the order view and, since R-1625,
   the payment-confirming view. */
import { COMPANY, WHATSAPP_NUMBER, whatsappDisplay } from "@/site/lib/config";

export const supportEmail = () => COMPANY.supportEmail;
export const phoneDisplay = () => whatsappDisplay(WHATSAPP_NUMBER);

export function whatsappLink(message: string): string {
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
}

export function mailtoLink(subject: string): string {
  return `mailto:${COMPANY.supportEmail}?subject=${encodeURIComponent(subject)}`;
}
