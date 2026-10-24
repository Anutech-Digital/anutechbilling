/**
 * R-1433: a link that opens ONE subscription's drawer on /subscriptions — used by the invoice
 * page's "Open subscription". `?open=<id>` opens the drawer; `?q=<domain>` (the R-244 search)
 * also filters the list to it, so the row is right there when the drawer is closed, and the
 * operator still lands on the right row if the drawer cannot open (e.g. a row this role cannot read).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function subscriptionOpenHref(s: { id: string; domain?: string | null; customer_name?: string | null }): string {
  const p = new URLSearchParams({ open: s.id });
  const q = (s.domain ?? "").trim() || (s.customer_name ?? "").trim();
  if (q) p.set("q", q);
  return `/subscriptions?${p.toString()}`;
}

/** The subscription id `?open=` asks for, or "" (only a well-formed id counts). */
export function openSubscriptionIdFromSearch(search: string): string {
  const id = new URLSearchParams(search).get("open")?.trim() ?? "";
  return UUID.test(id) ? id : "";
}
