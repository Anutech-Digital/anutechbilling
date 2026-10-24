/**
 * What a cart line renews at — the words under each line on the cart page and at checkout
 * (R-1628, 24 Oct 2026).
 *
 * The /domains page promised "renewal shown at checkout", but every yearly line there said only
 * "Renews yearly". Now a yearly line prints its renewal per year, incl. 18% GST, in the same words
 * as the quote (quoteRenewalText, R-1629):
 *   · a domain renews at its extension's RENEWAL price from the live rate card — the very figure
 *     the /domains page prints (getSiteTldPrices → the marketing layout → CartProvider) — not at
 *     its first-year price. Unknown → no number, never a guess.
 *   · any other yearly line (hosting, mailbox…) renews at its list price × qty: coupons and the
 *     yearly-hosting bundle are first-payment only (money.ts), and unitPrice is the full price.
 */
import { gstBreakup } from "@/lib/quotes/amounts";
import { quoteRenewalText } from "./data/quote-catalog";
import { cycleLabel, type CartLine } from "./money";

/** Extension (".in") → renewal ₹/yr ex GST, whole rupees — only the extensions the rate card prices. */
export type DomainRenewals = Readonly<Record<string, number>>;

export function domainRenewals(tlds: readonly { tld: string; renew: number | null }[]): DomainRenewals {
  const out: Record<string, number> = {};
  for (const t of tlds) if (t.renew != null && t.renew > 0) out[t.tld] = Math.round(t.renew);
  return out;
}

/** One year of this line at renewal, ex GST — null when it does not renew yearly or the price is unknown. */
function renewalExGst(line: CartLine, renewals: DomainRenewals): number | null {
  if (line.cycle !== "yearly") return null;
  const d = /^domain:(.+)$/.exec((line.sku ?? "").toLowerCase());
  if (d) {
    const r = renewals[`.${d[1]}`];
    return r != null && r > 0 ? r * line.qty : null;
  }
  return line.unitPrice > 0 ? Math.round(line.unitPrice) * line.qty : null;
}

/** "Renews ₹943/yr incl. 18% GST" — or the plain cycle words when there is no known figure. */
export function lineRenewalText(line: CartLine, renewals: DomainRenewals): string {
  const years = line.years ?? 1;
  const ex = renewalExGst(line, renewals);
  if (ex == null) return years > 1 ? `Renews after ${years} years, then yearly` : cycleLabel(line.cycle);
  const text = quoteRenewalText({ perMonth: null, yearlyOnce: 0, perYear: gstBreakup(ex).total });
  return years > 1 ? `After ${years} years: ${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;
}
