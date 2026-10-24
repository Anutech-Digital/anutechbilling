/**
 * R-1452 — a voice note needs a phone number to go to.
 *
 * Renewals' "🔊 Voice" used to fire POST /api/voice/whatsapp-note for a customer
 * with no phone and show the route's bare 400. Now the button checks first (no
 * send is attempted) and the route answers a missing phone with the same §24
 * copy — what happened, why, and a link to the customer page to add one.
 *
 * Kept local to voice notes on purpose: the Deals "Call" button (R-1426) has its
 * own no-phone check.
 */

/** Machine code the route returns so the button can show the right next step. */
export const NO_PHONE_CODE = "no_phone" as const;

/** HTTP status for "this customer has no phone" — the request is fine, the data is missing. */
export const NO_PHONE_STATUS = 422;

/** True only when there is something dialable-looking on file (not blank / whitespace). */
export function hasPhone(phone: string | null | undefined): phone is string {
  return typeof phone === "string" && /\d/.test(phone);
}

export interface NoPhoneNotice {
  code: typeof NO_PHONE_CODE;
  /** What happened. */
  error: string;
  /** Why + what to do next. */
  description: string;
  /** Where the phone is added. */
  href: string;
  actionLabel: string;
}

/** §24 copy for "no phone on this customer", shared by the button and the route. */
export function noPhoneNotice(customerId: string, customerName?: string | null): NoPhoneNotice {
  const who = customerName?.trim() || "this customer";
  return {
    code: NO_PHONE_CODE,
    error: "No phone number for this customer — add one",
    description: `A voice note goes to WhatsApp, and ${who} has no phone number saved. Nothing was sent. Add the number on the customer page, then try again.`,
    href: `/customers/${encodeURIComponent(customerId)}`,
    actionLabel: "Open customer",
  };
}
