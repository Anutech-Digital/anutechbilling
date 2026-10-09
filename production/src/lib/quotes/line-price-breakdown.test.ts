import { describe, it, expect } from "vitest";
import { linePriceBreakdown, linePriceBreakdownText, formatDiscountPct } from "./line-price-breakdown";

describe("linePriceBreakdown (R-495)", () => {
  it("list above rate → list, ₹ discount, %, final", () => {
    expect(linePriceBreakdown({ rate: 1800, list_rate: 2000 })).toEqual({ list: 2000, discount: 200, pct: 10, final: 1800 });
  });

  it("keeps one decimal of %", () => {
    expect(linePriceBreakdown({ rate: 1750, list_rate: 2000 })?.pct).toBe(12.5);
    expect(linePriceBreakdown({ rate: 2000, list_rate: 3000 })?.pct).toBe(33.3);
  });

  it("no discount (rate = list) → null, show only final", () => {
    expect(linePriceBreakdown({ rate: 2000, list_rate: 2000 })).toBeNull();
  });

  it("no list price on the line → null (never invented)", () => {
    expect(linePriceBreakdown({ rate: 2000 })).toBeNull();
    expect(linePriceBreakdown({ rate: 2000, list_rate: null })).toBeNull();
    expect(linePriceBreakdown({ rate: 2000, list_rate: 0 })).toBeNull();
  });

  it("rate above list (mark-up) → null", () => {
    expect(linePriceBreakdown({ rate: 2400, list_rate: 2000 })).toBeNull();
  });

  it("list and final go through the same unit conversion; % from stored figures", () => {
    const b = linePriceBreakdown({ rate: 18000, list_rate: 24000 }, (n) => Math.round(n / 12));
    expect(b).toEqual({ list: 2000, discount: 500, pct: 25, final: 1500 });
  });

  it("a tiny real discount never reads 0%", () => {
    expect(linePriceBreakdown({ rate: 99999, list_rate: 100000 })?.pct).toBe(0.1);
  });

  it("text", () => {
    const b = linePriceBreakdown({ rate: 1750, list_rate: 2000 })!;
    expect(linePriceBreakdownText(b, (n) => `₹${n}`)).toBe("List ₹2000 · Discount ₹250 (12.5%) · Final ₹1750");
    expect(formatDiscountPct(10)).toBe("10");
  });
});
