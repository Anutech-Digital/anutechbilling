/**
 * The one-line domain teaser on the homepage catalogue card and the header menu (R-462,
 * 10 Oct 2026).
 *
 * Both used to say "₹249 from · first year" — the first-year price of .store, which renews
 * at ₹4,199. Pardeep chose to lead with .in instead and to print its renewal next to it.
 * The numbers are read from TLDS, the same table /rates and /domains show, so the teaser
 * cannot drift from the rate card. "Renews at the same price" is only said when the data
 * proves it (renew === reg); otherwise the actual renewal price is printed.
 */
import { TLDS, type Tld } from "./catalog";

export const TEASER_TLD = ".in";

export interface DomainTeaser {
  tld: string;
  /** "₹499" */
  from: string;
  /** "₹799" */
  renew: string;
  /** "renews at ₹799" or "renews at the same price" */
  renewNote: string;
  /** ".in from ₹499/year (renews at ₹799)" */
  line: string;
}

const rupee = (n: number) => "₹" + n.toLocaleString("en-IN");

export function domainTeaser(tlds: readonly Tld[] = TLDS, tld: string = TEASER_TLD): DomainTeaser {
  const t = tlds.find((x) => x.tld === tld);
  if (!t) throw new Error(`domainTeaser: ${tld} is not in the rate card`);
  const from = rupee(t.reg);
  const renew = rupee(t.renew);
  const renewNote = t.renew === t.reg ? "renews at the same price" : `renews at ${renew}`;
  return { tld: t.tld, from, renew, renewNote, line: `${t.tld} from ${from}/year (${renewNote})` };
}

export const DOMAIN_TEASER: DomainTeaser = domainTeaser();
