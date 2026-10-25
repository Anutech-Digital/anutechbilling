/**
 * R-1893 (25 Oct 2026, Pardeep) — the customer record's own number, in one rule.
 *
 * The customer form saves a Phone and a Mobile on the customer (customers.contact_phone /
 * contact_mobile). Since R-1893 the PRIMARY CONTACT's phone is the one home of that number:
 * a new customer's contact is created with it (useCreateCustomer), a changed number is copied
 * to the primary contact by the database (trigger trg_r1893_sync_primary_contact_phone), and
 * old customers were backfilled once. Where the contact's phone is still blank, the screens
 * fall back to this — so a typed mobile always shows.
 *
 * Mobile first: it is the number that takes a call AND a WhatsApp. The same order as the
 * migration's backfill and trigger, so the screen and the database pick the same number.
 */
export function recordPhoneOf(c: {
  contact_mobile?: string | null;
  contact_phone?: string | null;
}): string | null {
  return c.contact_mobile?.trim() || c.contact_phone?.trim() || null;
}
