import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hostingPriceTable, hostingRate } from "./hosting-prices";
import { LANDING_PLANS } from "@/site/lib/data/hosting-landing";
import { GET } from "@/app/api/public/hosting-prices/route";

describe("hosting prices — one computation for checkout and the DMS panel", () => {
  it("is derived from LANDING_PLANS: yearly = per-month × 12, monthly = 2×, whole rupees, +18% GST", () => {
    const table = hostingPriceTable();
    expect(table.map((p) => p.id)).toEqual(["starter", "standard", "plus"]);
    for (const p of table) {
      const lp = LANDING_PLANS.find((l) => l.name.toLowerCase() === p.id);
      expect(lp).toBeDefined();
      expect(p.perMonthYearly).toBe(lp!.price);
      expect(p.yearly).toEqual({ months: 12, exGst: Math.round(lp!.price * 12), inclGst: Math.round(Math.round(lp!.price * 12) * 1.18) });
      expect(p.monthly.exGst).toBe(Math.round(lp!.price * 2));
    }
  });
  it("Starter yearly is ₹600 + GST = ₹708 (the figure charged on 26 and 28 Sep 2026)", () => {
    expect(hostingPriceTable()[0].yearly).toEqual({ months: 12, exGst: 600, inclGst: 708 });
  });
  it("an unknown tier has no rate — never a guessed one", () => {
    expect(hostingRate("gold", true)).toBeNull();
  });
  it("checkout charges through hostingRate, not its own formula", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/checkout/cart-checkout.ts"), "utf8");
    // R-1786: the same rule over the price book's tiers (= HOSTING_TIERS with CATALOG_FROM_DB off).
    expect(src).toMatch(/hostingRateIn\(book\.tiers, tier, yearly\)/);
    expect(src).not.toMatch(/Math\.round\(yearly \? t\.yearlyTotal : t\.monthly\)/);
  });
  it("the public endpoint publishes the table with the GST rate", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ gstRate: 0.18, plans: hostingPriceTable() });
  });
});
