/**
 * R-328 (7 Oct 2026, Pardeep): Google Workspace Business Plus shows NO price anywhere on the
 * public website — Google does not publish one either. "Contact us for pricing" + Get a quote /
 * WhatsApp instead. Starter and Standard keep their prices; the app keeps every price.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { publicWorkspaceCatalog } from "@/lib/catalog/public-workspace";
import { CONTACT_FOR_PRICING, isPublicPriceHidden } from "@/lib/catalog/public-price-policy";
import { mergeEditions, suitePriceRows, type LiveWorkspaceItem } from "@/site/lib/live-catalog";
import { EDITION_MATRICES, LICENCE_EDITIONS } from "@/site/lib/data/catalog";
import { QUOTE_PRODUCTS, withLiveEditions } from "@/site/lib/data/quote-catalog";
import { buildFacts } from "@/lib/ai/public-sales-chat";

const ROWS = [
  { name: "Google Workspace Business Starter", msrp: 270, prices: { monthly: { msrp: 325 } }, vendor: "google" },
  { name: "Google Workspace Business Standard", msrp: 1080, prices: { monthly: { msrp: 1300 } }, vendor: "google" },
  { name: "Google Workspace Business Plus", msrp: 1380, prices: { monthly: { msrp: 1620 } }, vendor: "google" },
];
const LIVE: LiveWorkspaceItem[] = [
  { name: "Google Workspace Business Starter", annualPerSeatMo: 270, monthlyPerSeatMo: 325, vendor: "google" },
  { name: "Google Workspace Business Standard", annualPerSeatMo: 1080, monthlyPerSeatMo: 1300, vendor: "google" },
  { name: "Google Workspace Business Plus", annualPerSeatMo: 1380, monthlyPerSeatMo: 1620, vendor: "google" },
];

describe("R-328 — no Business Plus price reaches a website visitor", () => {
  it("policy: Plus (app or website name) is hidden; Starter, Standard, add-ons are not", () => {
    expect(isPublicPriceHidden("Google Workspace Business Plus")).toBe(true);
    expect(isPublicPriceHidden("GW Business Plus")).toBe(true);
    expect(isPublicPriceHidden("Google Workspace Business Starter")).toBe(false);
    expect(isPublicPriceHidden("GW Business Standard")).toBe(false);
    expect(isPublicPriceHidden("Hosting Plus")).toBe(false);
  });

  it("the public catalogue endpoint drops the Plus row; Starter/Standard unchanged", () => {
    const out = publicWorkspaceCatalog(ROWS);
    expect(out.map((i) => i.name)).toEqual(["Google Workspace Business Starter", "Google Workspace Business Standard"]);
    expect(out[0]).toMatchObject({ annualPerSeatMo: 270, monthlyPerSeatMo: 325 });
    expect(out[1]).toMatchObject({ annualPerSeatMo: 1080, monthlyPerSeatMo: 1300 });
    expect(JSON.stringify(out)).not.toMatch(/1380|1620/);
  });

  it("merged editions (live and fallback) carry no Plus price", () => {
    for (const eds of [mergeEditions(LIVE), mergeEditions(null)]) {
      expect(eds.some((e) => isPublicPriceHidden(e.name))).toBe(false);
      expect(eds.find((e) => e.name === "GW Business Starter")?.annual).toBe(270);
      expect(eds.find((e) => e.name === "GW Business Standard")?.annual).toBe(1080);
    }
    expect(LICENCE_EDITIONS.some((e) => isPublicPriceHidden(e.name))).toBe(false);
  });

  it("compare-editions price row says 'Contact us for pricing' for Plus", () => {
    const rows = suitePriceRows(mergeEditions(LIVE));
    expect(rows["Google Workspace"]).toEqual(["₹270/mo", "₹1,080/mo", CONTACT_FOR_PRICING]);
    const typed = EDITION_MATRICES["Google Workspace"].rows.find((r) => /price per seat/i.test(r[0]));
    expect(typed?.[3]).toBe(CONTACT_FOR_PRICING);
  });

  it("/quote lists Plus as price on request — ₹0 in the maths, never its list price", () => {
    const products = withLiveEditions(QUOTE_PRODUCTS, mergeEditions(LIVE));
    const plus = products.find((p) => p.name === "GW Business Plus");
    expect(plus?.priceOnRequest).toBe(true);
    expect(plus?.annual).toBe(0);
    expect(products.find((p) => p.name === "GW Business Starter")?.annual).toBe(270);
  });

  it("the public sales chat has no Plus figure and is told it is price on request", () => {
    const f = buildFacts(publicWorkspaceCatalog(ROWS), { name: "Anutech", phone: null, supportHours: "x" });
    expect(f.factsText).not.toMatch(/1380|1,380|16,?560|1620/);
    expect(f.allowedFigures).not.toContain(1380);
    expect(f.factsText).toMatch(/Business Plus[^\n]*price on request/i);
  });

  it("no public-site source file types a Plus figure (₹1,380 / ₹16,560 / ₹1,620)", () => {
    const roots = ["site", "app/(marketing)", "app/(public)", "app/(lp)"].map((r) => join(__dirname, "..", r));
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(n) || /\.test\.tsx?$/.test(n)) continue;
        if (/1,380|\b1380\b|16,560|\b16560\b|1,620|\b1620\b/.test(readFileSync(p, "utf8"))) hits.push(relative(join(__dirname, ".."), p));
      }
    };
    roots.forEach(walk);
    expect(hits).toEqual([]);
  });
});
