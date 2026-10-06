/**
 * R-244: where Ctrl+K sends a subscription or a payment it found. Choosing one used to open
 * the whole list, so the operator searched twice. Now the list opens already filtered to the
 * row that was picked: a subscription by its domain (unique per customer, and what the search
 * box matches), a payment by its customer's id (the Payments page's `?customer=` view).
 */

/** The list filtered to one subscription — by domain, else customer name, else unfiltered. */
export function subscriptionHref(s: { domain?: string | null; customer_name?: string | null }): string {
  const q = (s.domain ?? "").trim() || (s.customer_name ?? "").trim();
  return q ? `/subscriptions?q=${encodeURIComponent(q)}` : "/subscriptions";
}

/** One customer's receipts when the payment knows its customer, else the full list. */
export function paymentHref(p: { customer_id?: string | null }): string {
  return p.customer_id ? `/payments?customer=${encodeURIComponent(p.customer_id)}` : "/payments";
}

/** The `?q=` the subscriptions page opens with (read from `location.search`). */
export function initialSubscriptionSearch(search: string): string {
  return new URLSearchParams(search).get("q")?.trim() ?? "";
}

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  trial: "Trial",
  paused: "Suspended",   // the page's own folder name for a paused row (lib/subscriptions/folders.ts)
  expired: "Expired",
  cancelled: "Cancelled",
};

/** A stored subscription status as a word a person reads. Display only. */
export function subscriptionStatusLabel(status: string | null | undefined): string {
  const s = (status ?? "").trim();
  if (!s) return "";
  const known = STATUS_LABEL[s.toLowerCase()];
  if (known) return known;
  const words = s.replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Picking a subscription while already ON /subscriptions changes only the query string, so the
 * page does not remount and its mount-time `?q=` read never runs again. The palette announces
 * the new search with this event as well; the page listens and fills its box.
 */
export const SUBSCRIPTION_SEARCH_EVENT = "reselleros:subscriptions-search";

/** The `q` a subscriptionHref carries ("" for the unfiltered list). */
export function searchFromSubscriptionHref(href: string): string {
  const i = href.indexOf("?");
  return i < 0 ? "" : initialSubscriptionSearch(href.slice(i));
}
