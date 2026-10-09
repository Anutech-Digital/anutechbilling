/**
 * R-445 (1) — the person a quote is addressed to: name, email, phone.
 *
 * Abhishek, Scenario 2 (8 Oct 2026): the preview of a quote raised on a lead ("This is how the
 * customer will see it") showed only the company under Bill To — Rohit Gupta's name, email and
 * phone were missing, because the preview callers passed nulls. Quotes have no contact columns
 * of their own; the customer row has them, and before a customer exists the lead does. One rule
 * for preview, downloaded PDF and emailed PDF: customer first, then lead, each field on its own.
 */

export interface ContactSource {
  contact_name?:  string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
}

export interface QuoteContact {
  contactName:  string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}

function clean(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
}

/** Customer's contact first, the lead's for any field the customer lacks. Blank → null. */
export function quoteContact(
  customer: ContactSource | null | undefined,
  lead?: ContactSource | null,
): QuoteContact {
  return {
    contactName:  clean(customer?.contact_name)  ?? clean(lead?.contact_name),
    contactEmail: clean(customer?.contact_email) ?? clean(lead?.contact_email),
    contactPhone: clean(customer?.contact_phone) ?? clean(lead?.contact_phone),
  };
}
