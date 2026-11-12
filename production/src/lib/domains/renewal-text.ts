/** R-2710: "Renewal, 1 year" / "Renewal, 3 years" — a domain renewal line's text (pure; used by the
 *  renewal quote (lib/domains/renewal.ts) and the quote builder's years picker (domain-term.ts)). */
export function domainRenewalDescription(years: number): string {
  return `Renewal, ${years} year${years === 1 ? "" : "s"}`;
}

/** Is this the text domainRenewalDescription wrote (so a years change may rewrite it)? */
export function isDomainRenewalDescription(text: unknown): boolean {
  return typeof text === "string" && /^Renewal, \d+ years?$/.test(text);
}
