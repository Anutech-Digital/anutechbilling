/**
 * R-224 (7 Oct 2026): /quote priced hosting from the old HOSTING_PLANS placeholder
 * (Starter ₹159/199, Business ₹359, Agency ₹799) while /hosting, /rates and the cart sell
 * HOSTING_TIERS (from LANDING_PLANS). /ssl promised "Wildcard on Agency" — a plan that does
 * not exist. And a GW edition with no flexible tier was quoted at its annual rate under
 * "Flexible monthly".
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { QUOTE_PRODUCTS, withLiveEditions, quoteRate, quoteInr } from "./quote-catalog";
import { HOSTING_TIERS } from "./hosting-landing-v2";
import { CERTS } from "./catalog";
import { buildRateCard } from "../rate-card";
import { mergeEditions } from "../live-catalog";

const hosting = QUOTE_PRODUCTS.filter((p) => p.vendor === "Web hosting");

describe("R-224 quote hosting = /hosting = /rates", () => {
  it("same plans, same names, same ₹/mo as HOSTING_TIERS", () => {
    expect(hosting.map((p) => p.label)).toEqual(HOSTING_TIERS.map((t) => `Web hosting — ${t.name}`));
    for (const t of HOSTING_TIERS) {
      const p = hosting.find((h) => h.label.endsWith(t.name))!;
      expect(p.annual, t.name).toBe(t.yearlyMo);
      expect(p.monthly, t.name).toBe(t.monthly);
    }
  });

  it("the ₹/mo /quote prints for Starter is the one /rates prints", () => {
    const rates = buildRateCard({ tlds: [], hosting: HOSTING_TIERS, editions: [], mailRates: {}, certs: [] });
    const starterRow = rates.find((s) => s.id === "hosting")!.rows.find((r) => r.name === "Starter")!;
    const starter = hosting.find((h) => h.label.endsWith("Starter"))!;
    expect(quoteInr(quoteRate(starter, "annual")!)).toBe(starterRow.cells[1]); // billed yearly
    expect(quoteInr(quoteRate(starter, "monthly")!)).toBe(starterRow.cells[0]); // billed monthly
  });
});

describe("R-224 no plan called Agency anywhere on the site", () => {
  it("src/site has no 'Agency' plan (the .agency TLD is lowercase and fine)", () => {
    const root = join(__dirname, "..", "..");
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && /\bAgency\b/.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });

  it("Free DV says wildcard comes with Plus", () => {
    const free = CERTS.find((c) => c.name === "Free DV")!;
    expect(free.lines).toContain("Wildcard on Plus");
  });
});

describe("R-224 Flexible monthly only when the product has a flexible tier", () => {
  const live = mergeEditions([
    { name: "Google Workspace Business Starter", annualPerSeatMo: 270, monthlyPerSeatMo: null },
    { name: "Google Workspace Business Standard", annualPerSeatMo: 1080, monthlyPerSeatMo: 1300 },
  ]);
  const products = withLiveEditions(QUOTE_PRODUCTS, live);
  const starter = products.find((p) => p.name === "GW Business Starter")!;
  const standard = products.find((p) => p.name === "GW Business Standard")!;

  it("GW Starter with no flexible tier is annual only — no monthly rate", () => {
    expect(starter.monthly).toBeNull();
    expect(quoteRate(starter, "monthly")).toBeNull();
    expect(quoteRate(starter, "annual")).toBe(270);
  });

  it("an edition with a flexible tier keeps its monthly rate", () => {
    expect(quoteRate(standard, "monthly")).toBe(1300);
  });

  it("no live data → placeholder monthly stays", () => {
    const p = withLiveEditions(QUOTE_PRODUCTS, undefined).find((x) => x.name === "GW Business Starter")!;
    expect(typeof p.monthly).toBe("number");
  });
});
