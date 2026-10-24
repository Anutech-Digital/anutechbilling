import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DOMAIN_TEASER_NO_PRICE, domainTeaser, teaserCardPrice, teaserTag, type TeaserTld } from "./domain-teaser";
import { buildRateCard, type RateTld } from "../rate-card";
import { CATALOGUE } from "./copy";
import { CATALOGUE_V2 } from "@/site/components/home/HomeV2";

/* R-462: the homepage + menu domain teaser said "₹249 from · first year" (.store's first
   year; it renews at ₹4,199). It leads with .in and prints the renewal.
   R-1599: the figures are the live rate card (getSiteTldPrices) the server passes in — the
   same rows /rates shows — and with no live price the teaser carries no number. */
const LIVE: RateTld[] = [
  { tld: ".in", use: "x", reg: 799, renew: 899, transfer: 799, live: true },
  { tld: ".com", use: "x", reg: 1049, renew: 1250, transfer: 1049, live: true },
];

describe("R-462 / R-1599 domain teaser matches /rates", () => {
  const ratesIn = () => {
    const domains = buildRateCard({ tlds: LIVE, hosting: [], editions: [], mailRates: {}, certs: [] }).find((s) => s.id === "domains");
    const row = domains?.rows.find((r) => r.name === ".in");
    if (!row) throw new Error(".in missing from /rates");
    return { reg: row.cells[0], renew: row.cells[1] };
  };

  it("uses the .in register and renew price that /rates shows", () => {
    const r = ratesIn();
    const t = domainTeaser(LIVE);
    expect(t.tld).toBe(".in");
    expect(t.from).toBe(r.reg);
    expect(t.renew).toBe(r.renew);
    expect(t.line).toBe(`.in from ${r.reg}/year (renews at ${r.renew})`);
  });

  it("only claims 'same price' when the data proves it", () => {
    const same: TeaserTld[] = [{ tld: ".in", reg: 499, renew: 499 }];
    expect(domainTeaser(same).line).toBe(".in from ₹499/year (renews at the same price)");
    const diff: TeaserTld[] = [{ tld: ".in", reg: 499, renew: 799 }];
    expect(domainTeaser(diff).line).toBe(".in from ₹499/year (renews at ₹799)");
  });

  it("no live price → no number, never a placeholder", () => {
    for (const t of [domainTeaser([]), domainTeaser([{ tld: ".in", reg: null, renew: null }]), DOMAIN_TEASER_NO_PRICE]) {
      expect(t.from).toBeNull();
      expect(t.line).not.toMatch(/₹/);
      expect(teaserTag(t)).not.toMatch(/₹/);
      expect(teaserCardPrice(t).from).not.toMatch(/₹/);
    }
    expect(domainTeaser([{ tld: ".in", reg: 799, renew: null }]).line).toBe(".in from ₹799/year (renewal shown at search)");
  });

  it("homepage card: the live .in price and its renewal, no ₹249 / first year", () => {
    const card = teaserCardPrice(domainTeaser(LIVE));
    expect(card.from).toBe(ratesIn().reg);
    expect(card.unit).toContain("renews at ₹899");
    expect(`${card.from} ${card.unit}`).not.toMatch(/₹249|first year/i);
    // The static cards (before the server passes the live teaser) carry no number.
    const staticCard = CATALOGUE_V2.find((c) => c.name === "Domains");
    expect(staticCard?.from).not.toMatch(/₹/);
    expect(CATALOGUE.find((c) => c.name === "Domains")?.from).not.toMatch(/₹/);
  });

  it("header menu has no hard-coded ₹249 / first-year domain teaser and takes the live one", () => {
    const src = readFileSync(path.join(__dirname, "../../components/chrome/Header.tsx"), "utf8");
    expect(src).not.toMatch(/₹249/);
    expect(src).not.toMatch(/first-year price/i);
    expect(src).toMatch(/domainTeaser/);
    expect(teaserTag(domainTeaser(LIVE))).toBe(".IN FROM ₹799/YR");
  });
});
