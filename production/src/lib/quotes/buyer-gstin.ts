/**
 * R-1485 — the buyer's GSTIN on a quote: builder, quote page, preview and every PDF.
 *
 * Sales tester (staging, 17 Oct 2026): "client ka GST number daala hai par quote bante waqt
 * GST number show nahi ho raha". The builder showed it, but the preview, the quote page's
 * Download PDF and the emailed PDF never passed it — only the v1 documents API did
 * (lib/pdf/build-props.ts). A B2B quote without the buyer's GSTIN is a weak tax document.
 *
 * One fact, one place: quotes store no GSTIN of their own. It is read from the CUSTOMER row;
 * before a customer exists, from the LEAD the quote was raised on. When a customer exists, its
 * row is the only source — a GSTIN typed on the lead long ago never overrides it.
 */

export interface GstinSource {
  gstin?: string | null;
}

export interface BuyerGstinCustomer extends GstinSource {
  id?: string | null;
  customer_type?: string | null;
  gst_treatment?: string | null;
  /** R-1004: a name-only row hides the GSTIN from this role — it is not "missing". */
  name_only?: boolean | null;
}

function clean(v: string | null | undefined): string | null {
  const t = (v ?? "").trim().toUpperCase();
  return t === "" ? null : t;
}

/** The GSTIN to print for this quote's buyer, or null. Customer's row first; the lead's only
 *  when there is no customer. */
export function quoteBuyerGstin(
  customer: GstinSource | null | undefined,
  lead?: GstinSource | null,
): string | null {
  if (customer) return clean(customer.gstin);
  return clean(lead?.gstin);
}

/** Treatments that are not a business buying in India — no GSTIN is expected of them. */
const NO_GSTIN_EXPECTED = new Set(["consumer", "overseas"]);

/**
 * Should the builder / quote page offer "GSTIN not on file — add it"? Only for a business
 * customer whose row we can read in full and that has no GSTIN: not an individual, not a
 * consumer or overseas buyer, not a name-only row (R-1004).
 */
export function buyerGstinMissing(customer: BuyerGstinCustomer | null | undefined): boolean {
  if (!customer || customer.name_only) return false;
  if (clean(customer.gstin)) return false;
  if (customer.customer_type === "individual") return false;
  if (customer.gst_treatment && NO_GSTIN_EXPECTED.has(customer.gst_treatment)) return false;
  return true;
}

/** Where "add it" goes: the customer's edit form, where the GSTIN field lives. */
export function addGstinHref(customerId: string): string {
  return `/customers/${customerId}/edit`;
}
