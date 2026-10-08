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

/**
 * R-389 (F8) — which ONE subscription of this quote should take the domain the operator
 * typed into Record payment?
 *
 * ─── THE BUG ────────────────────────────────────────────────────────────────
 * Q-FBB9-27-0013 (7 Oct): two payments, both with "testkapoorexports.in", and BOTH of the
 * quote's subscriptions (Google Workspace + Standard Support) stayed domain NULL. The
 * dialog ran `update subscriptions set domain = X where quote_id = Q and domain is null`,
 * which tries to give the SAME domain to every subscription of the quote — and
 * `subscriptions_tenant_quote_domain_unique (tenant_id, quote_id, lower(domain))` refuses
 * the second row, so Postgres rolls back the whole statement and nothing is stamped. The
 * error was only console-logged. A single-line quote (Q-FBB9-27-0010) has one row, which
 * is why the domain was saved there.
 *
 * ─── THE RULE ───────────────────────────────────────────────────────────────
 * The same one record_payment follows when it creates subscriptions: a quote's domain
 * goes on one subscription — repeats stay null. Prefer the licence the domain belongs
 * to (Google / Microsoft / Zoho seats) over support, hosting or "other"; skip it entirely
 * when some subscription of this quote already carries this domain.
 */
export interface DomainStampCandidate {
  id: string;
  vendor?: string | null;
  domain?: string | null;
}

const DOMAIN_VENDOR_RANK: Record<string, number> = { google: 0, microsoft: 1, zoho: 2 };

export function pickDomainStampTarget(
  subs: readonly DomainStampCandidate[],
  domain: string | null | undefined,
): string | null {
  const want = domain?.trim().toLowerCase();
  if (!want) return null;
  if (subs.some((s) => s.domain?.trim().toLowerCase() === want)) return null;
  const blank = subs.filter((s) => !s.domain?.trim());
  if (blank.length === 0) return null;
  const rank = (s: DomainStampCandidate) => DOMAIN_VENDOR_RANK[(s.vendor ?? "").toLowerCase()] ?? 9;
  /* Stable: equal ranks keep the order the caller passed (oldest first). */
  return [...blank].sort((a, b) => rank(a) - rank(b))[0].id;
}
