/**
 * R-1769 — a fixed TEST price list for domain search + checkout on a LAPTOP only.
 *
 * Why: `npm run dev:local` blanks the ResellerClub keys and the domains-platform address
 * (no live key may run on a laptop), so the real lookup can't answer and the checkout —
 * which re-reads the price before selling (owner decision 19: never sell on a guessed price)
 * — could not take a domain order to /done. Decision (b), 22 Oct 2026: on a laptop, read
 * this list instead, and mark every price it produces "TEST price".
 *
 * When it is used (testDomainPricesActive) — ALL of:
 *   - a simulated payment is allowed (simulatedPaymentAllowed, R-079): not a deployment
 *     (NODE_ENV=production, NEXT_PUBLIC_APP_ENV=production|staging, K_SERVICE) and no live
 *     Razorpay key in env;
 *   - no ResellerClub credentials on this server;
 *   - no domains platform configured (NEXT_PUBLIC_DOMAINS_APP_URL empty) — a developer who
 *     runs the real platform locally gets its answers, not this list.
 * The checkout also refuses a test-priced domain whenever the key it would charge with is
 * live (cart-checkout.ts), so a live key stored on the tenant cannot sell at these prices.
 */
import { simulatedPaymentAllowed } from "@/lib/checkout/live-guards";
import type { LiveDomain, LiveLookup } from "./live-lookup";

type Env = Record<string, string | undefined>;

/** 1-year TEST price per TLD, ₹ before GST. Plausible, round, and never read on a deployment. */
export const TEST_DOMAIN_PRICES: Readonly<Record<string, number>> = {
  com: 899,
  in: 649,
  "co.in": 449,
  net: 1099,
  org: 999,
};

/** Names that come back TAKEN on every TLD, so the "already registered" path can be tested. */
export const TEST_TAKEN_NAMES: readonly string[] = ["taken", "google", "anutech"];

/** Terms the list prices — the N-year total is N × the 1-year price. */
const TEST_TERMS = [1, 2, 3, 5];

export function testDomainPricesActive(opts: { rcConfigured: boolean; env?: Env }): boolean {
  const env = opts.env ?? process.env;
  if (opts.rcConfigured) return false;
  if ((env.NEXT_PUBLIC_DOMAINS_APP_URL ?? "").trim()) return false;
  const keyId = (env.RAZORPAY_KEY_ID ?? "").trim() || (env.NEXT_PUBLIC_RAZORPAY_KEY_ID ?? "").trim();
  return simulatedPaymentAllowed({ env, razorpayKeyId: keyId });
}

/** The lookup answered from the test list: same shape as the real one, every row marked. */
export function testLookup(base: string, tlds: readonly string[]): LiveLookup {
  const taken = TEST_TAKEN_NAMES.includes(base);
  const domains = tlds.map((tld): LiveDomain => {
    const price = TEST_DOMAIN_PRICES[tld] ?? 0;
    const priceKnown = !taken && price > 0;
    return {
      domain: `${base}.${tld}`,
      available: !taken,
      price: priceKnown ? price : 0,
      currency: "INR",
      years: 1,
      priceKnown,
      prices: priceKnown ? Object.fromEntries(TEST_TERMS.map((t) => [String(t), price * t])) : {},
      testPrice: true,
    };
  });
  return { ok: true, base, domains, source: "test" };
}
