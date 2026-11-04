/**
 * R-2108 — "?return=" on the customer edit form: where to go after Save / Cancel.
 *
 * Hosting & Domains → "Add email" opens /customers/<id>/edit?return=/hosting-domains, so the
 * person lands back on the list they were working through instead of the customer profile.
 * Only a path inside this app is followed (never "//host" or "https://…"), so a crafted link
 * cannot send anyone off-site.
 */
export function safeReturnPath(raw: string | null | undefined): string | null {
  const p = (raw ?? "").trim();
  if (!p.startsWith("/") || p.startsWith("//") || p.includes("\\") || p.length > 200) return null;
  return p;
}

/** The return path in a location's query string ("?return=/hosting-domains"), or null. */
export function returnPathFromSearch(search: string): string | null {
  return safeReturnPath(new URLSearchParams(search).get("return"));
}

/** The edit-form link that comes back to `back` after Save / Cancel. */
export function editCustomerHref(customerId: string, back: string): string {
  return `/customers/${customerId}/edit?return=${encodeURIComponent(back)}`;
}
