/**
 * R-1735 — "No GSTIN — invoice will be B2C. Add GSTIN?" on the desk Record payment sheet.
 *
 * R-1712 put a checksum-checked GSTIN box on the quote builder's New prospect; it is saved on
 * the prospect's lead and record_payment / accept_quote copy it to customers.gstin, which
 * generate_invoice freezes on the invoice. What was still missing: when nobody typed one, the
 * payment that issues the invoice said nothing — a registered buyer got a B2C invoice and lost
 * the input credit (the fix after issue is a credit note + a new invoice).
 *
 * A reminder, never a block (CGST Rule 46: an unregistered buyer's invoice needs no GSTIN —
 * same rule as issue-consequences.ts). One fact, one place: the "add it" link goes to where the
 * GSTIN already lives — the customer's edit form, or for a prospect the quote's own edit page
 * (its GSTIN box saves to the lead).
 */
import { addGstinHref, buyerGstinMissing, type BuyerGstinCustomer } from "@/lib/quotes/buyer-gstin";
import { validProspectGstin } from "@/lib/quotes/prospect-contact";

export interface B2cNudgeInput {
  quoteId: string;
  customerId: string | null;
  /** The customer row (null when there is none yet, or it was not loaded). */
  customer: (BuyerGstinCustomer & { country?: string | null }) | null;
  /** The prospect's lead, when the quote has no customer yet. */
  lead: { gstin?: string | null } | null;
  /** quotes.prospect_country — an overseas prospect needs no GSTIN. */
  prospectCountry?: string | null;
}

export interface B2cNudge {
  text: string;
  label: string;
  href: string;
}

function abroad(country: string | null | undefined): boolean {
  const c = (country ?? "").trim().toLowerCase();
  return c !== "" && !["in", "ind", "india"].includes(c);
}

export function b2cGstinNudge(i: B2cNudgeInput): B2cNudge | null {
  const text = "No GSTIN — invoice will be B2C.";
  const label = "Add GSTIN";
  if (i.customerId) {
    if (!i.customer || abroad(i.customer.country) || !buyerGstinMissing(i.customer)) return null;
    return { text, label, href: addGstinHref(i.customerId) };
  }
  if (abroad(i.prospectCountry) || validProspectGstin(i.lead?.gstin)) return null;
  return { text, label, href: `/quotes/${i.quoteId}/edit` };
}
