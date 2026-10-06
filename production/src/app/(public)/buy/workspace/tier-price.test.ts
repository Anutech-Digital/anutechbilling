/**
 * R-276: the Buy-now dialog shows what Razorpay will charge. A stale catalogue row (Starter
 * ₹136, Standard ₹736) is shown at list (₹270 / ₹1,080), and the dialog's total equals the
 * server's order amount (api/public/checkout/workspace/pricing.ts).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tierAnnualPrice, annualTotals } from "./tier-price";
import { buildLinesFromCatalog, type CatalogPriceRow } from "@/app/api/public/checkout/workspace/pricing";

const row = (name: string, annual: number): CatalogPriceRow => ({
  id: name, name, msrp: annual, wholesale: null,
  prices: { annual: { msrp: annual, wholesale: 0 } },
});

describe("R-276 Buy-now dialog price = charged price", () => {
  it("stale rows are lifted to list: Starter 136 → 270, Standard 736 → 1080", () => {
    expect(tierAnnualPrice("starter", 136)).toBe(270);
    expect(tierAnnualPrice("standard", 736)).toBe(1080);
  });

  it("a price above list is kept; enterprise / unknown untouched", () => {
    expect(tierAnnualPrice("starter", 300)).toBe(300);
    expect(tierAnnualPrice("enterprise", 50)).toBe(50);
  });

  it("10 Starter users from a ₹136 row: dialog total ₹38,232 = server amount", () => {
    const rate = tierAnnualPrice("starter", 136);
    const shown = annualTotals(10, rate);
    expect(shown).toEqual({ annual: 32_400, gst: 5_832, total: 38_232 });
    const server = buildLinesFromCatalog(row("Google Workspace Business Starter", 136), "starter", 10);
    expect(server.amount).toBe(shown.total);
    expect(server.subtotal).toBe(shown.annual);
  });

  it("Standard and Plus agree with the server too", () => {
    for (const [slug, name, stale, seats] of [
      ["standard", "Google Workspace Business Standard", 736, 7],
      ["plus", "Google Workspace Business Plus", 900, 3],
    ] as const) {
      const shown = annualTotals(seats, tierAnnualPrice(slug, stale));
      expect(buildLinesFromCatalog(row(name, stale), slug, seats).amount).toBe(shown.total);
    }
  });

  it("the dialog builds its tiers and totals through these helpers", () => {
    const src = readFileSync(join(__dirname, "buy-workspace-client.tsx"), "utf8");
    expect(src).toMatch(/annual\s*=\s*tierAnnualPrice\(slug,/);
    expect(src).toMatch(/annualTotals\(seats, baseRate\)/);
  });
});
