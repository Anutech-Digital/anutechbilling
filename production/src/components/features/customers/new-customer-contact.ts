/**
 * R-1738 (22 Oct 2026) — what a NEW customer must have, and who its contact is when
 * nobody was typed.
 *
 * Zoho Books asks only the name. We ask the name (the schema) plus ONE way to send the
 * invoice: an email or a phone. The primary contact person is optional — when it is
 * blank, the company itself is the contact ("Bharat Tiles"), the way a small business
 * actually works. Every reader that needs a contact name (useCreateCustomer →
 * attachPrimaryContact, the invoice / dunning recipient, the subscription file's
 * "Contact Name") therefore still gets one; nothing downstream sees a blank.
 */

/** Why this new customer cannot be saved yet, or null. Name rules live in the schema. */
export function newCustomerReachProblem(d: {
  contact_email?: string | null;
  contact_phone?: string | null;
  contact_mobile?: string | null;
}): string | null {
  const has = (v: string | null | undefined) => !!(v ?? "").trim();
  if (has(d.contact_email) || has(d.contact_phone) || has(d.contact_mobile)) return null;
  return "Add an email or a phone number — the invoice needs somewhere to go";
}

/** The typed person, else the customer's own name. */
export function defaultContactName(a: { personName: string | null | undefined; customerName: string | null | undefined }): string | null {
  return (a.personName ?? "").trim() || (a.customerName ?? "").trim() || null;
}

/** True when the saved contact is just the company's own name (no separate person). */
export function contactIsTheCompany(c: { contact_name?: string | null; name?: string | null }): boolean {
  const contact = (c.contact_name ?? "").trim().toLowerCase();
  return contact !== "" && contact === (c.name ?? "").trim().toLowerCase();
}
