/**
 * R-278 — who a quote is FOR, when the buyer is a lead with no company.
 *
 * Measured 6 Oct 2026 (local): a lead with an empty company and contact "Pardeep Sharma"
 * (pardeep.webmaster@gmail.com) was quoted, and Q-FBB9-27-0009 was saved and listed as
 * "Prospect". Searching the Quotes list by that email found nothing, because the list
 * searched only id / customer_name / plan.
 *
 * Two pure rules live here so the builder and the list cannot drift:
 *   - leadQuoteName: what the builder SAVES as customer_name in lead mode.
 *   - quotePartyName / quoteMatchesSearch: what the list SHOWS and SEARCHES, which also
 *     fixes the old "Prospect" rows without rewriting any data.
 *
 * "Prospect" stays the last-resort placeholder: lib/inbound/quote-match.ts treats it as a
 * useless name for matching, and that rule is unchanged.
 */

export const PLACEHOLDER_QUOTE_NAME = "Prospect";

export interface LeadContactBits {
  company?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
}

const clean = (s: string | null | undefined): string => (s ?? "").trim();

/** company → contact name → email → phone; "" when the lead has none of them. */
export function leadQuoteName(lead: LeadContactBits): string {
  return (
    clean(lead.company) ||
    clean(lead.contact_name) ||
    clean(lead.contact_email) ||
    clean(lead.contact_phone)
  );
}

/** A saved customer_name that names nobody (empty, or the builder's placeholder). */
export function isPlaceholderQuoteName(name: string | null | undefined): boolean {
  const n = clean(name).toLowerCase();
  return n === "" || n === PLACEHOLDER_QUOTE_NAME.toLowerCase();
}

/**
 * The name to show on a quote row. A real customer_name wins; a placeholder row falls
 * back to its lead's contact (old quotes saved as "Prospect" read correctly with no
 * data change); with nothing better, the saved name (or "Prospect").
 */
export function quotePartyName(
  customerName: string | null | undefined,
  lead?: LeadContactBits | null,
): string {
  if (!isPlaceholderQuoteName(customerName)) return clean(customerName);
  const fromLead = lead ? leadQuoteName(lead) : "";
  return fromLead || clean(customerName) || PLACEHOLDER_QUOTE_NAME;
}

/** Digits only, so "+91 98990 12345" is found by "98990". */
const digits = (s: string): string => s.replace(/\D/g, "");

/**
 * The Quotes list search: id, saved name, plan, and the lead's contact name / email /
 * phone. Phone matches on digits when the term has at least 3 of them.
 */
export function quoteMatchesSearch(
  q: { id: string; customer_name: string | null; plan?: string | null },
  lead: LeadContactBits | null | undefined,
  term: string,
): boolean {
  const s = term.trim().toLowerCase();
  if (!s) return true;
  const texts = [
    q.id,
    q.customer_name,
    q.plan,
    lead?.company,
    lead?.contact_name,
    lead?.contact_email,
    lead?.contact_phone,
  ];
  if (texts.some((t) => clean(t).toLowerCase().includes(s))) return true;
  const d = digits(s);
  if (d.length >= 3 && d.length === s.replace(/[\s+\-()]/g, "").length) {
    const phone = digits(clean(lead?.contact_phone));
    if (phone.includes(d)) return true;
  }
  return false;
}
