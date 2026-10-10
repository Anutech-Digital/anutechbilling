import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TLDS, type Tld } from "./catalog";
import { DOMAIN_TEASER, domainTeaser } from "./domain-teaser";
import { buildRateCard } from "../rate-card";
import { CATALOGUE } from "./copy";
import { CATALOGUE_V2 } from "@/site/components/home/HomeV2";

/* R-462: the homepage + menu domain teaser said "₹249 from · first year" (.store's first
   year; it renews at ₹4,199). It now leads with .in and prints the renewal, from the same
   table /rates reads. */
describe("R-462 domain teaser matches /rates", () => {
  const ratesIn = () => {
    const domains = buildRateCard({ tlds: TLDS, hosting: [], editions: [], mailRates: {}, certs: [] }).find((s) => s.id === "domains");
    const row = domains?.rows.find((r) => r.name === ".in");
    if (!row) throw new Error(".in missing from /rates");
    return { reg: row.cells[0], renew: row.cells[1] };
  };

  it("uses the .in register and renew price that /rates shows", () => {
    const r = ratesIn();
    expect(DOMAIN_TEASER.tld).toBe(".in");
    expect(DOMAIN_TEASER.from).toBe(r.reg);
    expect(DOMAIN_TEASER.renew).toBe(r.renew);
    expect(DOMAIN_TEASER.line).toBe(`.in from ${r.reg}/year (renews at ${r.renew})`);
  });

  it("only claims 'same price' when the data proves it", () => {
    const same: Tld[] = [{ tld: ".in", reg: 499, renew: 499, transfer: 499, use: "x", group: "Popular" }];
    expect(domainTeaser(same).line).toBe(".in from ₹499/year (renews at the same price)");
    const diff: Tld[] = [{ tld: ".in", reg: 499, renew: 799, transfer: 649, use: "x", group: "Popular" }];
    expect(domainTeaser(diff).line).toBe(".in from ₹499/year (renews at ₹799)");
    expect(() => domainTeaser([], ".in")).toThrow();
  });

  it("homepage card shows the .in price and its renewal, no ₹249 / first year", () => {
    const card = CATALOGUE_V2.find((c) => c.name === "Domains");
    expect(card?.from).toBe(ratesIn().reg);
    expect(card?.unit).toContain(DOMAIN_TEASER.renewNote);
    expect(`${card?.from} ${card?.unit}`).not.toMatch(/₹249|first year/i);
    const old = CATALOGUE.find((c) => c.name === "Domains");
    expect(old?.from).toBe(DOMAIN_TEASER.line);
  });

  it("header menu has no hard-coded ₹249 / first-year domain teaser", () => {
    const src = readFileSync(path.join(__dirname, "../../components/chrome/Header.tsx"), "utf8");
    expect(src).not.toMatch(/₹249/);
    expect(src).not.toMatch(/first-year price/i);
    expect(src).toMatch(/DOMAIN_TEASER/);
  });
});
