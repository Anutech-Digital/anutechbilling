import { describe, it, expect } from "vitest";
import { grossAmount, quoteAmountGap, isQuoteAmountConsistent, QUOTE_AMOUNT_TOLERANCE, taxableAfterDiscount, gstBreakup } from "./amounts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("quote amount integrity", () => {
  it("clears the 26 production quotes whose numbers agree", () => {
    // Representative shapes measured 21 Aug 2026: plain, discounted, and zero-rated.
    expect(isQuoteAmountConsistent(103680, 18, 122342)).toBe(true);
    expect(isQuoteAmountConsistent(362880, 18, 428198)).toBe(true);
    expect(isQuoteAmountConsistent(0, 18, 0)).toBe(true);
    expect(isQuoteAmountConsistent(45360, 0, 45360)).toBe(true);
  });

  it("catches Q-2026-9776, the one quote missing its GST", () => {
    // subtotal ₹45,360 at 18% must be ₹53,525; the row says ₹45,360.
    expect(quoteAmountGap(45360, 18, 45360)).toBe(8165);
    expect(isQuoteAmountConsistent(45360, 18, 45360)).toBe(false);
  });

  it("tolerates a rupee of legacy rounding, but not two", () => {
    expect(isQuoteAmountConsistent(103680, 18, 122342 + QUOTE_AMOUNT_TOLERANCE)).toBe(true);
    expect(isQuoteAmountConsistent(103680, 18, 122342 - QUOTE_AMOUNT_TOLERANCE)).toBe(true);
    expect(isQuoteAmountConsistent(103680, 18, 122342 + QUOTE_AMOUNT_TOLERANCE + 1)).toBe(false);
    expect(isQuoteAmountConsistent(103680, 18, 122342 - QUOTE_AMOUNT_TOLERANCE - 1)).toBe(false);
  });

  it("signs the gap so the direction is unambiguous", () => {
    // Positive = the quote is billing LESS than its own tax rate implies.
    expect(quoteAmountGap(100000, 18, 100000)).toBeGreaterThan(0);
    // Negative = it is billing more.
    expect(quoteAmountGap(100000, 18, 130000)).toBeLessThan(0);
  });
});

describe("grossAmount", () => {
  it("adds 18% GST to a Standard ×10 annual renewal subtotal", () => {
    // 10 seats × ₹864/mo × 12 = ₹1,03,680 ex-GST → ₹1,22,342 incl 18% GST
    expect(grossAmount(103680, 18)).toBe(122342);
  });

  it("defaults to 18%", () => {
    expect(grossAmount(103680)).toBe(122342);
  });

  it("rounds the tax (half-up) like the quote builder", () => {
    // 103680 * 0.18 = 18662.4 → 18662
    expect(grossAmount(103680, 18) - 103680).toBe(18662);
  });

  it("handles zero", () => {
    expect(grossAmount(0, 18)).toBe(0);
  });

  it("handles a 2-year extension subtotal (mrr×12×2)", () => {
    // 8640×12×2 = 207360 ex-GST → 207360 + 37325 = 244685
    expect(grossAmount(207360, 18)).toBe(244685);
  });

  it("supports other GST rates", () => {
    expect(grossAmount(1000, 5)).toBe(1050);
    expect(grossAmount(1000, 0)).toBe(1000);
  });
});

describe("coupon / discount quotes (R-082)", () => {
  it("taxable value is subtotal net of the rounded discount, like generate_invoice", () => {
    expect(taxableAfterDiscount(600, 10)).toBe(540);
    expect(taxableAfterDiscount(999, 15)).toBe(999 - 150);
    expect(taxableAfterDiscount(600, 0)).toBe(600);
  });

  it("a 10% coupon quote (₹600 − 10% + 18% = ₹637) is consistent once the discount is counted", () => {
    expect(isQuoteAmountConsistent(600, 18, 637, 10)).toBe(true);
    expect(isQuoteAmountConsistent(600, 18, 637)).toBe(false); // the old check, which refused it
  });

  it("still catches a coupon quote whose GST is missing", () => {
    expect(isQuoteAmountConsistent(600, 18, 540, 10)).toBe(false);
    expect(quoteAmountGap(600, 18, 540, 10)).toBe(97);
  });
});

describe("gstBreakup — R-1438: GST forward from the taxable value, never back-solved", () => {
  it("3,839.88 @ 18% → GST 691.18, payable 4,531.06 (Pawan's staging case, 15–16 Oct 2026)", () => {
    // GW Business Starter ₹270 × 12 + Hosting Starter ₹49.99 × 12 = ₹3,839.88. The old maths rounded the payable to ₹4,531
    // first and showed GST ₹691.12; the tax invoice charges 18% directly = ₹691.18.
    expect(gstBreakup(3839.88, 18)).toEqual({ taxable: 3839.88, gst: 691.18, total: 4531.06 });
  });

  it("whole-rupee taxable values give exactly what grossAmount gives (app quotes unchanged)", () => {
    for (const [t, r] of [[103680, 18], [45360, 18], [1000, 5], [600, 18], [207360, 18], [0, 18]] as const) {
      expect(gstBreakup(t, r).total).toBe(grossAmount(t, r));
      expect(gstBreakup(t, r).gst).toBe(grossAmount(t, r) - t);
    }
  });

  it("shown subtotal + shown GST === shown payable across amounts and rates (R-1108 rule)", () => {
    const shown = (n: number) => Math.round(n * 100) / 100;
    const amounts = [3839.88, 49.99, 599.88, 319.99 * 12 + 1080 * 12, 1023.88, 12.5, 0.01, 99999.99, 3840, 1, 7];
    const rates = [0, 5, 12, 18, 28];
    for (const a of amounts) for (const r of rates) {
      const b = gstBreakup(a, r);
      expect(shown(b.taxable + b.gst)).toBe(shown(b.total));
      expect(b.gst).toBe(shown(b.gst));
      // and the GST is the rate applied to the taxable value, within half a unit of rounding
      expect(Math.abs(b.gst - (a * r) / 100)).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });

  it("the website quote builder no longer back-solves GST from a rounded payable", () => {
    const src = readFileSync(resolve(__dirname, "../../site/components/quote/QuoteBuilder.tsx"), "utf8");
    expect(src).not.toContain("payable - subtotal");
    expect(src).not.toContain("Math.round(subtotal * 1.18)");
    expect(src).toContain("gstBreakup(subtotal)");
  });
});
