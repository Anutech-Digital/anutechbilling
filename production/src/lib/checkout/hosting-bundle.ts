/**
 * What a yearly hosting plan brings free (R-1595, 18 Oct 2026 — decided by Pardeep).
 *
 * Each YEARLY hosting line brings:
 *   · the FIRST YEAR of ONE domain free — only the domain that plan is set up on, only when that
 *     domain is being registered in the same cart, and only for a common TLD in FREE_DOMAIN_TLDS.
 *     A plan set up on a domain the buyer already owns frees no other domain. A costly TLD
 *     (.ai, .io, .co …) is charged in full;
 *   · ONE mailbox (one unit, one year) free.
 * Monthly plans bring nothing. Every other domain and mailbox is charged in full. Until R-1595
 * the checkout made EVERY domain and EVERY mailbox ₹0 once any yearly plan was in the cart.
 *
 * Pure, so the server (cart-checkout.ts — the site cart and the DMS panel order) and the site
 * (domains page copy and calculator; the cart page, R-1601) share one rule. The server charges.
 */

/** The TLDs whose first year is free with a yearly hosting plan. Change the offer here only. */
export const FREE_DOMAIN_TLDS = ["com", "in", "net", "org", "co.in"] as const;

/** ".com / .in / .net / .org / .co.in" — for copy that names the offer. */
export const FREE_DOMAIN_TLDS_LABEL = FREE_DOMAIN_TLDS.map((t) => `.${t}`).join(" / ");

/** Whether a domain (or a bare TLD like ".in" / "co.in") can be the free one. */
export function freeDomainEligible(domainOrTld: string): boolean {
  const d = domainOrTld.trim().toLowerCase().replace(/^\./, "");
  return FREE_DOMAIN_TLDS.some((t) => d === t || d.endsWith(`.${t}`));
}

export interface BundlePlan {
  yearly: boolean;
  /** The domain this plan is set up on, already normalised (planDomains), or null. */
  domain: string | null;
}

export interface BundleAllowance {
  /** Indexes into `domains` whose first year is free. */
  freeDomains: Set<number>;
  /** How many mailbox units are free in the whole cart. */
  freeMailboxes: number;
}

/**
 * @param plans          every hosting line, in cart order
 * @param domains        every domain being registered, in cart order, lower-case
 * @param mailboxUnits   the total mailbox quantity in the cart
 */
export function bundleAllowance(plans: BundlePlan[], domains: string[], mailboxUnits: number): BundleAllowance {
  const yearly = plans.filter((p) => p.yearly);
  const freeDomains = new Set<number>();
  for (const p of yearly) {
    if (!p.domain || !freeDomainEligible(p.domain)) continue;
    const i = domains.findIndex((d, idx) => d === p.domain && !freeDomains.has(idx));
    if (i >= 0) freeDomains.add(i);
  }
  return { freeDomains, freeMailboxes: Math.max(0, Math.min(Math.floor(mailboxUnits), yearly.length)) };
}
