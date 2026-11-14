/**
 * R-2824 — the contact block's facts (renewal drawer + renewal follow-up dialog): who to call for
 * this renewal and the links to do it. Pure, so the rules are tested without a screen.
 *
 * The person is the app's one main contact (RowContact from renewals/queue-data: the primary
 * contact, the customer's contact_* columns filling what it leaves empty — R-2108 rule). The
 * number is read with the customer's own country (lib/phone — R-2641/R-2645), never a fixed +91:
 * a US number saved without a code gets 1, an Indian one 91.
 */
import { phoneE164ForCountry, whatsAppLink } from "@/lib/phone";
import { isMaskedContact } from "@/lib/auth/roles";

export interface RenewalContactInput {
  name: string | null;
  email: string | null;
  phone: string | null;
  /** customers.country — the dialling code for a number saved without one. */
  country?: string | null;
}

export interface RenewalContactView {
  name: string | null;
  /** The number as shown: "+91 …" with its code when we can read it, else as saved. */
  phoneText: string | null;
  telHref: string | null;
  whatsappHref: string | null;
  email: string | null;
  mailHref: string | null;
  /** The role may not see the number / email (the data gateway masks it) — shown, never linked. */
  masked: boolean;
}

/** null = nothing to show → the block says "No contact — Add contact". */
export function renewalContactView(c: RenewalContactInput | null | undefined): RenewalContactView | null {
  const name = c?.name?.trim() || null;
  const phone = c?.phone?.trim() || null;
  const email = c?.email?.trim() || null;
  if (!phone && !email) return null;
  const masked = (!!phone && isMaskedContact(phone)) || (!!email && isMaskedContact(email));
  const e164 = phone && !masked ? phoneE164ForCountry(phone, c?.country) : "";
  return {
    name,
    phoneText: phone ? (e164 || phone) : null,
    telHref: e164 ? `tel:${e164}` : null,
    whatsappHref: phone && !masked ? whatsAppLink(phone, c?.country) : null,
    email,
    mailHref: email && !masked ? `mailto:${email}` : null,
    masked,
  };
}
