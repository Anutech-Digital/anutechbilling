import { describe, it, expect } from "vitest";
import { headlinePrice, headlineSuffix, isOwnService } from "./headline-price";

describe("headlinePrice (2 Oct 2026)", () => {
  it("a monthly row shows its per-month msrp", () => {
    expect(headlinePrice({ msrp: 136, prices: {} })).toEqual({ amount: 136, unit: "mo" });
  });
  it("a yearly-total plan shows the year, not ₹0/mo", () => {
    expect(headlinePrice({ msrp: 0, prices: { annual_total: { msrp: 9996, wholesale: 0 } } })).toEqual({ amount: 9996, unit: "yr" });
  });
  it("a free plan stays ₹0/mo", () => {
    expect(headlinePrice({ msrp: 0, prices: null })).toEqual({ amount: 0, unit: "mo" });
  });
  it("R-526: a per-year row shows /yr, a one-time row once", () => {
    expect(headlinePrice({ msrp: 999, prices: { billing_unit: "unit_year" } })).toEqual({ amount: 999, unit: "yr" });
    expect(headlinePrice({ msrp: 199, prices: { billing_unit: "one_time" } })).toEqual({ amount: 199, unit: "once" });
    expect(headlineSuffix({ msrp: 1080, prices: {} })).toBe("/seat/mo");
    expect(headlineSuffix({ msrp: 199, vendor: "hosting", prices: {} })).toBe("/mo");
    expect(headlineSuffix({ msrp: 999, prices: { billing_unit: "unit_year" } })).toBe("/yr");
  });
  it("support is own service", () => {
    expect(isOwnService({ vendor: "support" })).toBe(true);
    expect(isOwnService({ vendor: "google" })).toBe(false);
  });
});
