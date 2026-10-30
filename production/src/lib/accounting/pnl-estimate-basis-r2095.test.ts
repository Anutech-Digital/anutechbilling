/**
 * R-2095 (staging P&L, 30 Oct 2026): "Cost of goods (licence cost)" said estimated, and its
 * drill-down opened "COGS — vendor bills in this period: No transactions". When the cost is
 * estimated, the period carries HOW: the licence revenue, the subscription book's wholesale ÷ price
 * ratio, and the vendors (subscriptions, seats, book price and cost) behind that ratio.
 */
import { describe, it, expect } from "vitest";
import { buildPnl, type VendorInput } from "./pnl";

const google: VendorInput = { vendor: "google", revenue: 100_000, billedCost: null, estimatedCost: 60_000, seats: 200, subscriptions: 9 };
const zoho: VendorInput = { vendor: "zoho", revenue: 20_000, billedCost: null, estimatedCost: 12_000, seats: 20, subscriptions: 2 };

describe("R-2095 the estimate's basis", () => {
  it("no bills: ratio = book cost ÷ book price, applied to licence revenue, with the vendors behind it", () => {
    const p = buildPnl({ revenue: 200_000, expenses: 0, billedCogs: null, billedByVendor: {}, vendors: [google, zoho] });
    expect(p.cogsBasis).toBe("estimated");
    expect(p.estimateBasis).toMatchObject({
      licenceRevenue: 200_000, ratioPct: 60, estimated: 120_000,
    });
    expect(p.estimateBasis?.vendors.map((v) => [v.vendor, v.subscriptions, v.seats, v.bookRevenue, v.bookCost])).toEqual([
      ["google", 9, 200, 100_000, 60_000],
      ["zoho", 2, 20, 20_000, 12_000],
    ]);
  });
  it("a small ratio keeps two decimals (not × 0%)", () => {
    const tiny: VendorInput = { vendor: "microsoft", revenue: 6_526, billedCost: null, estimatedCost: 25, seats: 2, subscriptions: 1 };
    const p = buildPnl({ revenue: 10_000, expenses: 0, billedCogs: null, billedByVendor: {}, vendors: [tiny] });
    expect(p.estimateBasis?.ratioPct).toBe(0.38);
  });
  it("a billed vendor is not in the basis", () => {
    const p = buildPnl({ revenue: 200_000, expenses: 0, billedCogs: 5_000, billedByVendor: { zoho: 5_000 }, vendors: [google, zoho] });
    expect(p.estimateBasis?.vendors.map((v) => v.vendor)).toEqual(["google"]);
  });
  it("all billed → no basis", () => {
    const p = buildPnl({ revenue: 200_000, expenses: 0, billedCogs: 72_000, billedByVendor: { google: 60_000, zoho: 12_000 }, vendors: [google, zoho] });
    expect(p.estimateBasis).toBeNull();
  });
});
