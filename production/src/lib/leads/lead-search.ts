/**
 * The "Search leads & deals" rule — ONE definition for the Kanban board (list-selectors.ts
 * #searchLeads, in the browser) and the list (list_leads() / lead_counts() on the server,
 * mirrored by list-page.ts#matchesListLeadsFilters). R-221, 6 Oct 2026.
 *
 * Before: the whole box was ONE substring of ONE field. A stray space, a name plus a company
 * ("asha alpha"), or a phone typed the way people say it ("98765 43210" for
 * "+91-98765-43210") found nothing (staging report 5289b49f).
 *
 * Now:
 *   1. The text is lowercased, trimmed and its whitespace runs collapsed to one space.
 *   2. Every word must appear in at least one of company / contact name / email / phone /
 *      plan — words may come from different fields, any order.
 *   3. A box that looks like a phone number (only digits, spaces, + - ( ) and 5+ digits) also
 *      matches by DIGITS against the lead's phone digits. More than 10 digits starting with
 *      91 or 0 is cut to the last 10, so "+91 98765 43210" and "09876543210" find
 *      "98765-43210".
 *
 * The SQL twin is public.lead_search_hit() (migration 20261007000000_lead_search_tokens.sql);
 * lead-search-sql.test.ts holds the two to the same constants.
 */

/** The fields the box searches. */
export interface LeadSearchFields {
  company: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  plan: string | null;
}

/** Fewer digits than this is ordinary text ("2024"), not a phone number. */
export const PHONE_MIN_DIGITS = 5;
/** Only digits, spaces and + - ( ), starting with + or a digit. Mirrored in the SQL. */
export const PHONE_LIKE = /^[+0-9][0-9 ()+-]*$/;

/** Lowercase, trim, collapse whitespace. "" = no search. */
export function normalizeLeadSearch(search: string): string {
  return search.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The digits a phone-like box is matched by, or null when the box is not phone-like. */
export function phoneSearchDigits(normalized: string): string | null {
  if (!PHONE_LIKE.test(normalized)) return null;
  let digits = normalized.replace(/[^0-9]/g, "");
  if (digits.length < PHONE_MIN_DIGITS) return null;
  if (digits.length > 10 && (digits.startsWith("91") || digits.startsWith("0"))) digits = digits.slice(-10);
  return digits;
}

/** Does this lead match the search box? A blank box matches every lead. */
export function leadMatchesSearch(l: LeadSearchFields, search: string): boolean {
  const q = normalizeLeadSearch(search);
  if (q === "") return true;
  const digits = phoneSearchDigits(q);
  if (digits !== null && (l.contact_phone ?? "").replace(/[^0-9]/g, "").includes(digits)) return true;
  const fields = [l.company, l.contact_name, l.contact_email, l.contact_phone, l.plan]
    .map((v) => (v ?? "").toLowerCase());
  return q.split(" ").every((word) => fields.some((f) => f.includes(word)));
}
