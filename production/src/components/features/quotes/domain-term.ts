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
import { domainRenewalDescription, isDomainRenewalDescription } from "@/lib/domains/renewal-text";

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
  /* R-2710: a domain renewal line says its term ("Renewal, 1 year") — the text follows the years,
     so the PDF never reads "1 year" next to a 3-year price. Any other text is the operator's. */
  if (isDomainRenewalDescription(line.description)) out.description = domainRenewalDescription(to);
  return out;
}

/**
 * R-2723 — the line as it goes into a commitment change. Flexible (monthly) has no "Register for
 * N years": a line that carried years 2–10 kept them (hidden — the picker is not shown on a
 * monthly line) and its WHOLE-term rate was divided by 12, so a 3-year ₹2,400 domain became ₹200 a
 * month, three times one year's month. It is brought back to ONE year first (rate, list rate and
 * cost = the yearly figure, `years` removed); the builder then converts the unit as for any line.
 * Every other change returns the line untouched.
 */
export function lineForCommitment(line: QuoteLineItem, commitment: QuoteLineItem["commitment"] | null): QuoteLineItem {
  return commitment === "monthly" && domainLineYears(line) > 1 ? lineForYears(line, 1) : line;
}

/**
 * Does this line get the "Register for N years" picker? The existing rule (a domain purchase,
 * or a name saying domain / registration) OR a catalogue item from the Domain vendor — the
 * catalogue names its domain items ".in", ".com", and those had no picker.
 *
 * R-2712: a BULK line of a domain item gets it too (it was refused outright, so "Bulk / many
 * domains" could never be more than 1 year) — by the same two rules. A bulk Workspace line still
 * does not, nor a Flexible (monthly) bulk line: years are whole-year terms.
 */
export function isTermLine(line: QuoteLineItem, domainItemIds: ReadonlySet<string>): boolean {
  if (line.bulk && line.commitment === "monthly") return false;
  if (isDomainRegistrationLine(line.bulk ? { ...line, bulk: false } : line)) return true;
  return !!line.item_id && domainItemIds.has(line.item_id);
}
