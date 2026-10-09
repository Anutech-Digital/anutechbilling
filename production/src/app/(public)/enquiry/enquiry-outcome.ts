/**
 * R-456 — what the /enquiry thank-you panel says, from what the server REALLY did.
 *
 * It used to promise "A confirmation is on its way to your inbox" on every save — also when
 * both emails had failed ("No email provider" in email_log). The route already returns
 * `ackSent` (true only when the customer's copy was sent); this reads it. Saved but not
 * emailed → we say the team has it and will contact them, and nothing about the inbox.
 */
import { GST_STATE_BY_CODE } from "@/lib/utils";

export function enquiryThanksText(brandName: string, ackSent: boolean): string {
  const base = `We've got your requirement and someone from ${brandName} will get back to you shortly.`;
  return ackSent
    ? `${base} A confirmation is on its way to your inbox.`
    : `${base} We could not email you a copy right now, but your enquiry is saved, so there is no need to send it again.`;
}

/** Indian states for the optional State field, A–Z (GST codes 97/99 are not places). */
export const ENQUIRY_STATES: { code: string; name: string }[] = Object.entries(GST_STATE_BY_CODE)
  .filter(([code]) => Number(code) < 90)
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name));

/** The state name for a code from the form, or null when none/unknown was picked. */
export function enquiryStateName(code: string | null | undefined): string | null {
  if (!code) return null;
  return ENQUIRY_STATES.find((s) => s.code === code)?.name ?? null;
}
