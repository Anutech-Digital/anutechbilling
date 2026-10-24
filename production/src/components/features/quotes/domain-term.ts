/**
 * R-1445 — a domain line's registration term in the quote builder (tested in domain-term.test.ts).
 *
 * The line's `rate` is the price for the WHOLE term (R-156, the same as the cart), so changing
 * "Register for" from 1 to 3 years has to make it three times the yearly price — it used to keep
 * the 1-year number and quote a 3-year domain at one year's money. The yearly figure is
 * recovered from the current term, so 1 → 3 → 2 lands on 2 × yearly, whole rupees.
 *
 * The subscription filed from such a line renews `years` after its start (trigger
 * subscription_term_follows_line, migration …_r1445_subscription_term_follows_line.sql).
 */
import type { QuoteLineItem } from "@/lib/supabase/database.types";
import { domainLineYears } from "@/lib/provisioning/products";
import { isDomainRegistrationLine } from "@/lib/quotes/seat-lines";

const clampYears = (y: number) => Math.max(1, Math.min(10, Math.trunc(Number.isFinite(y) ? y : 1)));

/** The line for `years` of registration: rate, list rate and cost = yearly figure × years. */
export function lineForYears(line: QuoteLineItem, years: number): QuoteLineItem {
  const from = domainLineYears(line);
  const to = clampYears(years);
  const scale = (n: number) => Math.round((n / from) * to);
  const out: QuoteLineItem = {
    ...line,
    rate: scale(line.rate),
    cost: scale(line.cost),
    years: to > 1 ? to : undefined,
  };
  if (line.list_rate !== undefined) out.list_rate = scale(line.list_rate);
  return out;
}

/**
 * Does this line get the "Register for N years" picker? The existing rule (a domain purchase,
 * or a name saying domain / registration) OR a catalogue item from the Domain vendor — the
 * catalogue names its domain items ".in", ".com", and those had no picker.
 */
export function isTermLine(line: QuoteLineItem, domainItemIds: ReadonlySet<string>): boolean {
  if (line.bulk) return false;
  if (isDomainRegistrationLine(line)) return true;
  return !!line.item_id && domainItemIds.has(line.item_id);
}
