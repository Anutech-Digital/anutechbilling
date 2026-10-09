/**
 * One hosting account per hosting line (R-032, 1 Oct 2026).
 *
 * Each hosting line in the cart is one account on its own domain (`hostingDomain`), and the
 * webhook queues one hosting request per line. So several plans are one order, but a single
 * line with quantity 2 is refused: it would be two accounts with only one domain between them.
 * The cart's "+" on a hosting plan adds a second LINE for that reason (9 Oct 2026), so a
 * quantity above 1 only reaches checkout from an old saved cart or a hand-made request.
 *
 * Until 28 Sep 2026 a cart holding two hosting plans was charged in full and only the first
 * account was ever set up. Until 1 Oct a switch (SEVERAL_HOSTING_PLANS_READY) kept a second plan
 * out of the order altogether; it was removed on 9 Oct 2026 with its "for now" wording.
 */

export interface HostingLimitLine {
  sku?: string;
  qty: number;
}

const isHosting = (sku: string | undefined) => /^hosting:/i.test(sku ?? "");

/** The hosting line with quantity above 1, described, or null when every line is one account. */
function doubledHosting(lines: HostingLimitLine[]): string | null {
  const doubled = lines.find((l) => isHosting(l.sku) && l.qty > 1);
  return doubled ? `a hosting plan with quantity ${doubled.qty}` : null;
}

/** A §7 message when a hosting line asks for more than one account, otherwise null. */
export function hostingLimitProblem(lines: HostingLimitLine[]): string | null {
  const why = doubledHosting(lines);
  if (!why) return null;
  return (
    `This order has ${why}. Each hosting account is set up on its own domain, so add the plan once for each ` +
    "website, with that website's domain. Nothing was charged."
  );
}

/**
 * The same rule, said BEFORE the customer pays (30 Sep 2026). The cart, the cart drawer and
 * checkout's first step say it as soon as such a line is in the cart.
 */
export function hostingLimitWarning(lines: HostingLimitLine[]): string | null {
  const why = doubledHosting(lines);
  if (!why) return null;
  return `Your cart has ${why}. Add the plan once for each website instead, each with its own domain.`;
}
