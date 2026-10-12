/**
 * Is this lead already a customer?
 *
 * ─── THE BUG ────────────────────────────────────────────────────────────────
 * Pressing "Send Quote" on a lead opened the quote builder on the **Existing customer**
 * tab with an empty dropdown. Pardeep reported it as "existing customer selected nahi
 * aata", and the interesting part is that it was two different faults wearing one symptom:
 *
 *   • For a lead that IS already in the customer book, nothing looked it up. The operator
 *     had to find their own customer in a dropdown, on a page they reached FROM that
 *     customer's lead.
 *   • For a lead that is NOT a customer — "Demo1 Company", stage `contact`, and none of the
 *     four customers matches it — there was nothing to select at all. The form was sitting
 *     on a tab that could never be satisfied, and the operator's only correct move was to
 *     notice the other tab and switch to it.
 *
 * quote-builder.tsx:199 skipped its prospect-seeding entirely in lead mode
 * (`if (isLeadMode || customerId) return`), so the toggle stayed on its initial "existing"
 * and nothing ever moved it.
 *
 * ─── MATCH ON EMAIL FIRST, NAME SECOND ──────────────────────────────────────
 * An email address is a near-identifier: two businesses do not share one. A company NAME
 * is not — "Demo Co" is a lead here and also a customer, and this tenant's own
 * history (CLAUDE.md §4a) is a case of two records sharing a name and not being the same
 * organisation.
 *
 * So an email hit is trusted outright, and a name hit only when it is EXACT after
 * normalisation. No fuzzy matching: selecting the wrong customer silently addresses a
 * quote — and later an invoice — to someone else, which is worse than making the operator
 * pick.
 */

export interface MatchableCustomer {
  id: string;
  name: string | null;
  contact_email?: string | null;
}

export interface LeadIdentity {
  company?: string | null;
  contactEmail?: string | null;
}

export type CustomerMatch =
  | { kind: "email"; customerId: string }
  | { kind: "name";  customerId: string }
  | { kind: "none" };

/** Lower-cased, punctuation-stripped, whitespace-collapsed. */
function normaliseName(v: string | null | undefined): string {
  return (v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normaliseEmail(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

/**
 * The customer this lead already is, if any.
 *
 * Returns the reason alongside the id so a caller can say WHY it preselected — an
 * unexplained selection on a money document is one an operator has to verify by hand,
 * which costs more than it saved.
 */
export function matchLeadToCustomer(
  lead: LeadIdentity,
  customers: readonly MatchableCustomer[],
): CustomerMatch {
  const email = normaliseEmail(lead.contactEmail);
  if (email) {
    const hit = customers.find((c) => normaliseEmail(c.contact_email) === email);
    if (hit) return { kind: "email", customerId: hit.id };
  }

  const name = normaliseName(lead.company);
  if (name) {
    /* Exactly one match only. Two customers normalising to the same name is precisely the
       situation where a machine must not choose — see the tenant-name history in §4a. */
    const hits = customers.filter((c) => normaliseName(c.name) === name);
    if (hits.length === 1) return { kind: "name", customerId: hits[0].id };
  }

  return { kind: "none" };
}

/** One line explaining a preselection, or null when nothing was matched. */
export function matchNote(match: CustomerMatch, companyName?: string | null): string | null {
  switch (match.kind) {
    case "email":
      return "Matched to an existing customer by email address.";
    case "name":
      return `Matched to your existing customer “${companyName ?? "this company"}” by name — check it is the same business before sending.`;
    case "none":
      return null;
  }
}
