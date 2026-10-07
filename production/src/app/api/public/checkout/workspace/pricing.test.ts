import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildLinesFromCatalog, type CatalogPriceRow } from "./pricing";

/* R-206 (6 Oct 2026): the website "Buy now" checkout read the catalogue row and charged its
   price. A stale Standard row at ₹736 would have created a Razorpay order at ₹736/seat/month —
   below list (₹1,080) and below cost. The R-205 floor (lib/catalog/workspace-floor.ts) now
   sits between the row and the order amount. Annual commitment = 12 months; +18% GST. */

vi.spyOn(console, "warn").mockImplementation(() => {});

const STALE_STARTER: CatalogPriceRow = {
  id: "GW-STR", name: "Google Workspace Business Starter", msrp: 136, wholesale: 110,
  prices: { monthly: { msrp: 170, wholesale: 138 }, annual: { msrp: 136, wholesale: 110 } },
};
const STALE_STANDARD: CatalogPriceRow = {
  id: "GW-STD", name: "Google Workspace Standard", msrp: 736, wholesale: 620,
  prices: { annual: { msrp: 736, wholesale: 620 } },
};

describe("Workspace checkout order amount never below list (R-206)", () => {
  it("Starter row at ₹136 → ₹270 × seats × 12 months + GST", () => {
    const b = buildLinesFromCatalog(STALE_STARTER, "starter", 5);
    expect(b.monthlyMsrp).toBe(270);
    expect(b.items[0].rate).toBe(270 * 12);
    expect(b.subtotal).toBe(270 * 5 * 12);              // ₹16,200
    expect(b.amount).toBe(Math.round(270 * 5 * 12 * 1.18)); // ₹19,116
    expect(Number.isInteger(b.amount)).toBe(true);
  });

  it("Standard row at ₹736 → ₹1,080 × seats × 12 months + GST", () => {
    const b = buildLinesFromCatalog(STALE_STANDARD, "standard", 3);
    expect(b.monthlyMsrp).toBe(1080);
    expect(b.subtotal).toBe(1080 * 3 * 12);              // ₹38,880
    expect(b.amount).toBe(Math.round(1080 * 3 * 12 * 1.18)); // ₹45,878
  });

  it("the floor uses the tier the buyer picked, even if the row name is odd", () => {
    const odd: CatalogPriceRow = { ...STALE_STANDARD, name: "Standard (old SKU)" };
    expect(buildLinesFromCatalog(odd, "standard", 1).monthlyMsrp).toBe(1080);
  });

  it("a price ABOVE list is kept (a catalogue price rise still reaches checkout)", () => {
    const up: CatalogPriceRow = { ...STALE_STANDARD, msrp: 1200, prices: { annual: { msrp: 1200, wholesale: 900 } } };
    expect(buildLinesFromCatalog(up, "standard", 2).subtotal).toBe(1200 * 2 * 12);
  });

  it("no catalogue row → list price", () => {
    expect(buildLinesFromCatalog(null, "plus", 1).monthlyMsrp).toBe(1380);
  });

  it("the route prices through this module (not its own copy)", () => {
    const route = readFileSync(join(process.cwd(), "src/app/api/public/checkout/workspace/route.ts"), "utf8");
    expect(route).toMatch(/from "\.\/pricing"/);
    expect(route).not.toMatch(/function resolveMonthlyMsrp/);
  });
});
