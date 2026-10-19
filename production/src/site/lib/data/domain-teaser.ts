/**
 * The one-line domain teaser on the homepage catalogue card and the header menu (R-462,
 * 10 Oct 2026).
 *
 * Both used to say "₹249 from · first year" — the first-year price of .store, which renews
 * at ₹4,199. Pardeep chose to lead with .in instead and to print its renewal next to it.
 * "Renews at the same price" is only said when the data proves it (renew === reg);
 * otherwise the actual renewal price is printed.
 *
 * R-1599 (18 Oct 2026): the numbers are the LIVE registry prices (getSiteTldPrices — what
 * the checkout charges), passed in by the server layout/page. They used to be read from
 * catalog.ts TLDS, whose figures are placeholders. With no live price the teaser carries
 * no number at all (DOMAIN_TEASER_NO_PRICE) — never the placeholder.
 */

export const TEASER_TLD = ".in";

/** A live rate-card row — only what the teaser reads. */
export interface TeaserTld {
  tld: string;
  reg: number | null;
  renew: number | null;
}

export interface DomainTeaser {
  tld: string;
  /** "₹499", or null when the live price is not known right now */
  from: string | null;
  /** "₹799", or null when not known */
  renew: string | null;
  /** "renews at ₹799" / "renews at the same price" / "renewal shown at search" */
  renewNote: string;
  /** ".in from ₹499/year (renews at ₹799)", or a no-number line */
  line: string;
}

const rupee = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

export function domainTeaser(tlds: readonly TeaserTld[], tld: string = TEASER_TLD): DomainTeaser {
  const t = tlds.find((x) => x.tld === tld);
  if (!t || t.reg == null) {
    return { tld, from: null, renew: null, renewNote: "renewal shown at search", line: `${tld} and 500+ extensions — live price and renewal at search` };
  }
  const from = rupee(t.reg);
  const renew = t.renew == null ? null : rupee(t.renew);
  const renewNote = renew == null ? "renewal shown at search" : t.renew === t.reg ? "renews at the same price" : `renews at ${renew}`;
  return { tld: t.tld, from, renew, renewNote, line: `${t.tld} from ${from}/year (${renewNote})` };
}

/** The big figure + small unit of the homepage "Domains" card. */
export function teaserCardPrice(t: DomainTeaser): { from: string; unit: string } {
  return t.from
    ? { from: t.from, unit: `from · ${t.tld} /year · ${t.renewNote}` }
    : { from: "Live price", unit: `at search · ${t.tld}, .com and 500+ more` };
}

/** The header promo tag: ".IN FROM ₹499/YR", or no number when the live price is unknown. */
export function teaserTag(t: DomainTeaser): string {
  return (t.from ? `${t.tld} from ${t.from}/yr` : `${t.tld} · live prices`).toUpperCase();
}

/** The teaser with no live price — what a client component shows before/without one. */
export const DOMAIN_TEASER_NO_PRICE: DomainTeaser = domainTeaser([]);
