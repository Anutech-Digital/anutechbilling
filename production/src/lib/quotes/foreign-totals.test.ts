/* R-1677 — one USD total for builder, accept page, preview, invoice and PDF. */
import { describe, it, expect } from "vitest";
import { foreignQuoteFigures, foreignUnit, cents, foreignDocConverter } from "./foreign-totals";

describe("foreignQuoteFigures (R-1677)", () => {
  it("Q-5F40-27-0100: 10 seats at ₹3,240, rate 95.7485, export → $33.84 × 10 = $338.40 (not $338, not $338.39)", () => {
    const f = foreignQuoteFigures({ lines: [{ qty: 10, rate: 3240 }], fx: 95.7485, taxRate: 0 });
    expect(f.lines[0].unit).toBe(33.84);
    expect(f.lines[0].amount).toBe(338.4);
    expect(f.subtotal).toBe(338.4);
    expect(f.tax).toBe(0);
    expect(f.total).toBe(338.4);
    /* The naive ₹ total ÷ rate is a different number — the reason this rule exists. */
    expect(cents(32400 / 95.7485)).toBe(338.39);
  });

  it("lines always add up to the subtotal; qty × unit == amount", () => {
    const f = foreignQuoteFigures({ lines: [{ qty: 32, rate: 2700 }, { qty: 3, rate: 999 }], fx: 84.37, taxRate: 18 });
    for (const [i, l] of f.lines.entries()) expect(l.gross).toBe(cents([32, 3][i] * l.unit));
    expect(f.subtotal).toBe(cents(f.lines[0].amount + f.lines[1].amount));
    expect(f.total).toBe(cents(f.taxable + f.tax));
  });

  it("a line's own discount_pct and the quote discount are taken off, to the cent", () => {
    const f = foreignQuoteFigures({ lines: [{ qty: 2, rate: 1000, discount_pct: 10 }], fx: 100, discountPct: 5, taxRate: 0 });
    expect(f.lines[0]).toEqual({ unit: 10, gross: 20, amount: 18 });
    expect(f.discount).toBe(0.9);
    expect(f.total).toBe(17.1);
  });

  it("foreignUnit never divides by a missing rate", () => {
    expect(foreignUnit(100, 0)).toBe(0);
    expect(cents(1.005)).toBe(1.01);
  });
});

describe("foreignDocConverter (R-1677) — the invoice prints the quote's dollar total", () => {
  const lines = [{ qty: 10, rate: 3240 }];
  const inr = { subtotal: 32400, taxable: 32400, tax: 0, total: 32400 };

  it("INV-5F40-27-0072: ₹32,400 → $338.40 (the quote's total), not $338.39", () => {
    const toFx = foreignDocConverter({ lines, fx: 95.7485, taxRate: 0, inr });
    expect(toFx(32400)).toBe(338.4);
    expect(toFx(3240)).toBe(33.84);
    expect(toFx(0)).toBe(0);
  });

  it("an invoice for part of the lines (an instalment) converts plainly", () => {
    const toFx = foreignDocConverter({ lines, fx: 95.7485, taxRate: 0, inr: { subtotal: 8100, taxable: 8100, tax: 0, total: 8100 } });
    expect(toFx(8100)).toBe(cents(8100 / 95.7485));
  });
});
