/**
 * R-379 (h) — where "Duplicate & edit" goes.
 *
 * Live 7 Oct (Q-FBB9-27-0011): the quote belonged to an existing customer, and the copy came
 * out with customer_id null, labelled "prospect". The menu passed `?leadId=` whenever the
 * quote had a lead, and the builder treats ANY `?leadId=` as lead mode — which saves
 * `customer_id: null` by design (a prospect quote). A quote that already has a customer must
 * open as that customer's quote: the builder copies `customer_id` from the source, and still
 * keeps the lead link from the source row (`linkedLeadId`), so nothing is lost by leaving
 * `leadId` out of the URL.
 */
export interface DuplicateSource {
  id: string;
  customer_id?: string | null;
  lead_id?: string | null;
  customer_name?: string | null;
}

export function duplicateQuoteHref(q: DuplicateSource): `/quotes/new?${string}` {
  const params = new URLSearchParams();
  params.set("duplicate", q.id);
  if (!q.customer_id) {
    // A prospect quote: carry the lead context forward, as before.
    if (q.lead_id)       params.set("leadId", q.lead_id);
    if (q.customer_name) params.set("company", q.customer_name);
  }
  return `/quotes/new?${params.toString()}`;
}
