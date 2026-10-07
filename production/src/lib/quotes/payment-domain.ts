/**
 * Which domain should the Record-Payment dialog pre-fill?
 *
 * ─── THE REPORT ─────────────────────────────────────────────────────────────
 * "Yaha domain automatically fill nhi hua" — filed 22 Aug 2026 from
 * /quotes/Q-TEST-2026-27-0009. Measured: the quote carries domain "xyz.cloudsolutions",
 * the customer row has none, and the page was passing
 *
 *     defaultDomain={customer?.domain ?? lead?.domain ?? undefined}
 *
 * so it consulted the customer and the lead and never the QUOTE — the one record that is
 * actually being paid, and the one the operator typed the domain into while building it.
 *
 * ─── WHY THE QUOTE WINS ─────────────────────────────────────────────────────
 * It is the most specific and most recent statement of intent for THIS sale. A customer
 * with acme.com who buys a second Workspace for acme.in has that written on the quote;
 * preferring their older customer-level domain would silently provision the wrong one, and
 * the subscription's unique index is on (tenant, quote, lower(domain)) — so the wrong
 * domain does not collide with anything, it just quietly becomes a second subscription for
 * a domain nobody sells.
 *
 * The lead stays last: it is the earliest and least confirmed of the three.
 */

export interface DomainSources {
  /** `quotes.domain` — what this sale is for. */
  quoteDomain?: string | null;
  /** `customers.domain` — the customer's general domain. */
  customerDomain?: string | null;
  /** `leads.domain` — the earliest guess, from before they were a customer. */
  leadDomain?: string | null;
  /**
   * R-379 (j): domains on subscriptions that already exist — THIS quote's first (e.g. the
   * one "Activate now, pay later" created), then the customer's other subscriptions.
   * Live 7 Oct (Q-FBB9-27-0011): the customer row had no domain, but its subscription
   * carried the domain, and Record payment still opened the required Domain field empty.
   */
  quoteSubscriptionDomains?: readonly (string | null | undefined)[];
  customerSubscriptionDomains?: readonly (string | null | undefined)[];
}

/**
 * The first source that actually has one, or undefined.
 *
 * Blank and whitespace-only are treated as absent: a form that saved an empty string must
 * not out-rank a real domain further down the chain, which is the same class of bug as the
 * one this fixes — a value that exists without meaning anything.
 *
 * Returns `undefined` rather than `null` so it can be handed straight to a prop typed
 * `string | null | undefined` without the caller re-normalising it.
 */
export function paymentDomainDefault(sources: DomainSources): string | undefined {
  /* Order: the quote, the subscription this quote already made, the customer, the
     customer's other subscriptions, and the lead last. */
  for (const candidate of [
    sources.quoteDomain,
    ...(sources.quoteSubscriptionDomains ?? []),
    sources.customerDomain,
    ...(sources.customerSubscriptionDomains ?? []),
    sources.leadDomain,
  ]) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}
