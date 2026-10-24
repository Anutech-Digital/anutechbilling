/**
 * R-1443 — one customer + domain + item is ONE subscription (tested in duplicate-subscription.test.ts).
 *
 * Pardeep (staging, 14 Oct): the Onboard dialog let the same customer, same domain and same item
 * be created twice — two renewals, two invoices for one service. Pratik (14 Oct): while typing the
 * company, show the customer that already exists so it is reused, not re-created.
 *
 * A live row (anything but cancelled / expired — a suspended one is still the customer's
 * subscription) with the same customer, the same domain and the same catalogue item (or, for a
 * custom plan with no item, the same plan name) is the duplicate. A different item for the same
 * company is a normal second subscription and is allowed.
 */

export interface ExistingSub {
  id: string;
  customer_id: string | null;
  domain: string | null;
  plan: string | null;
  item_id: string | null;
  status: string | null;
}

/** Statuses that are no longer a running service — a new subscription may replace them. */
const ENDED = new Set(["cancelled", "expired"]);

/** The domain as the dialog stores it: lower case, no scheme, no trailing slash. */
export function cleanDomain(d: string | null | undefined): string {
  return (d ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "").trim();
}

const norm = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/** A plan name without the " (5 seats)" the paid path's quote line adds (onboarding-line.ts). */
const planKey = (s: string | null | undefined) => norm(s).replace(/\s*\(\d+ seats?\)$/, "");

export function findDuplicateSubscription(
  subs: readonly ExistingSub[],
  want: { customerId: string; domain: string; itemId: string | null; plan: string },
): ExistingSub | null {
  if (!want.customerId) return null;
  const domain = cleanDomain(want.domain);
  if (!domain) return null;
  const plan = planKey(want.plan);
  return subs.find((s) => {
    if (s.customer_id !== want.customerId || ENDED.has(norm(s.status)) || cleanDomain(s.domain) !== domain) return false;
    /* Same catalogue item; or, when either side has no item link (a custom plan, or a row
       filed by record_payment before the item was resolved), the same plan name. */
    if (want.itemId && s.item_id) return s.item_id === want.itemId;
    return plan !== "" && planKey(s.plan) === plan;
  }) ?? null;
}

export interface CustomerOption { id: string; name: string; domain?: string | null }

/**
 * Existing customers matching what is typed in Company Name: every typed word in the name, or
 * the text inside the domain. 2+ letters; an exact name first; capped (a picker, not a report).
 */
export function matchCustomers<T extends CustomerOption>(list: readonly T[], typed: string, limit = 5): T[] {
  const q = norm(typed);
  if (q.length < 2) return [];
  const words = q.split(" ");
  const hits = list.filter((c) => {
    const name = norm(c.name);
    return words.every((w) => name.includes(w)) || (!!c.domain && norm(c.domain).includes(q));
  });
  const exact = hits.filter((c) => norm(c.name) === q);
  const rest = hits.filter((c) => norm(c.name) !== q);
  return [...exact, ...rest].slice(0, limit);
}
