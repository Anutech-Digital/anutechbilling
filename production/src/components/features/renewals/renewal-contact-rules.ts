/**
 * R-2824 — the contact block's facts (renewal drawer + renewal follow-up dialog): who to call for
 * this renewal and the links to do it. Pure, so the rules are tested without a screen.
 *
 * The person is the app's one main contact (RowContact from renewals/queue-data: the primary
 * contact, the customer's contact_* columns filling what it leaves empty — R-2108 rule). The
 * number is read with the customer's own country (lib/phone — R-2641/R-2645), never a fixed +91:
 * a US number saved without a code gets 1, an Indian one 91.
 */
import { dialCodeForCountry, formatInternationalPhone, phoneDigitsForCountry, phoneE164ForCountry, splitDialCode, whatsAppLink } from "@/lib/phone";
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
  /** The number as shown: "+91 98765 98765" (displayPhone, R-2857) when we can read it, else as saved. */
  phoneText: string | null;
  telHref: string | null;
  whatsappHref: string | null;
  email: string | null;
  mailHref: string | null;
  /** The role may not see the number / email (the data gateway masks it) — shown, never linked. */
  masked: boolean;
}

/**
 * R-2857: ONE way to write a phone on the Renewals rows, cards, drawer and follow-up dialog —
 * "+91 98765 98765" (lib/phone formatInternationalPhone, the form the phone field itself saves),
 * with the customer's country for a number saved without a code. It was shown as saved:
 * "+919876598765", "+91-9898989898", "9876543210" on three rows. Display only — nothing is saved.
 * A masked number ("••••••3210") stays as it is — and so does anything that is not plainly ONE
 * number, because a wrong guess would print (and dial) a number nobody saved: two numbers in one
 * field ("98765 43210 / 90000 00001"), a note ("… (accounts)"), a typo with a digit too many, an
 * Indian landline / toll-free ("1800 123 4567" must not turn into a US "+1 800 …").
 */
export function displayPhone(phone: string | null | undefined, country?: string | null): string | null {
  const raw = phone?.trim() || null;
  if (!raw || isMaskedContact(raw)) return raw;
  if (!/^[+\d(][\d\s\-().]*$/.test(raw)) return raw;
  const digits = phoneDigitsForCountry(raw, country);
  if (!digits || digits.length > 15) return raw;
  const { code, national } = splitDialCode(digits);
  if (!code) return raw;
  /* saved without a code → it must be a number OF the customer's country (India when unknown) */
  const ownCode = raw.startsWith("+") || raw.replace(/\D/g, "").startsWith("00");
  if (!ownCode && code !== (dialCodeForCountry(country) ?? "91")) return raw;
  if (code === "91" && !/^[6-9]\d{9}$/.test(national)) return raw;
  if (code === "1" && national.length !== 10) return raw;
  return formatInternationalPhone(digits);
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
    phoneText: displayPhone(phone, c?.country),
    telHref: e164 ? `tel:${e164}` : null,
    whatsappHref: phone && !masked ? whatsAppLink(phone, c?.country) : null,
    email,
    mailHref: email && !masked ? `mailto:${email}` : null,
    masked,
  };
}
