/**
 * What a yearly hosting plan brings free (R-1595, 18 Oct 2026).
 *
 * The site's promise, and nothing more:
 *   /domains   — "The domain is ₹0 when it points at our hosting (yearly plan)."
 *   /domains   — "Add one mailbox on <domain> — free with the plan."
 * So each YEARLY hosting line brings:
 *   · ONE domain's first year free — the domain that plan is set up on when it is in the cart,
 *     otherwise the first domain in the cart not already given free (card R-1595);
 *   · ONE mailbox (one unit, one year) free.
 * Monthly plans bring nothing. Every other domain and mailbox is charged in full. Until R-1595
 * the checkout made EVERY domain and EVERY mailbox ₹0 once any yearly plan was in the cart.
 *
 * Pure, so the server (cart-checkout.ts — the site cart and the DMS panel order) and the cart
 * page (R-1601) can share one rule. The server is the one that charges.
 */

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
  let unserved = 0;
  // First pass: a plan's own domain, when it is being bought in this cart.
  for (const p of yearly) {
    const i = p.domain ? domains.findIndex((d, idx) => d === p.domain && !freeDomains.has(idx)) : -1;
    if (i >= 0) freeDomains.add(i);
    else unserved += 1;
  }
  // Second pass: a plan whose domain is not in the cart frees the first domain not yet free.
  for (; unserved > 0; unserved -= 1) {
    const i = domains.findIndex((_d, idx) => !freeDomains.has(idx));
    if (i < 0) break;
    freeDomains.add(i);
  }
  return { freeDomains, freeMailboxes: Math.max(0, Math.min(Math.floor(mailboxUnits), yearly.length)) };
}
