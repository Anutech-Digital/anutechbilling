/**
 * R-066 — a quote-less invoice must never be taxed on its own tax.
 *
 * The reported case is pinned by its real numbers rather than a toy: INV-FBB9-2026-27-0003,
 * ₹5,90,000 gross, shown as "Tax Total ₹1,06,200 (18%)" when the truth is ₹90,000. The
 * difference, ₹16,200 on one invoice, is what a customer would have read off the PDF.
 *
 * Two halves:
 *   1. the arithmetic, including the shape of the OLD answer, so the test says what it is
 *      protecting against and not merely what it expects;
 *   2. a source scan of the page, because the defect was a fallback expression and a unit
 *      test of a helper cannot see a screen that stops calling it (L85).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { invoiceDisplayAmounts } from "./display-amounts";

/** The invoice from the bug report, as generate_invoice would have written it. */
const REPORTED = { amount: 590000, taxable_value: 500000, tax_amount: 90000, tax_rate: 18 };

describe("an invoice with no quote", () => {
  it("shows the GST that was frozen on it, not 18% of the gross", () => {
    const a = invoiceDisplayAmounts(REPORTED, null);
    expect(a.tax).toBe(90000);
    expect(a.taxable).toBe(500000);
    expect(a.total).toBe(590000);

    /* The old line, spelled out. It is here so that anyone reading this test knows the
       number they are protecting against, and so a future refactor that quietly
       re-introduces it fails on a value rather than on a phrase. */
    const whatItUsedToShow = Math.round(590000 * 0.18);
    expect(whatItUsedToShow).toBe(106200);
    expect(a.tax).not.toBe(whatItUsedToShow);
  });

  it("the parts add up — taxable + tax is the gross, exactly", () => {
    /* A GST document whose lines do not sum is wrong even when each line is defensible;
       this is the property, not a spot value. */
    for (const amount of [590000, 118, 100000, 1, 999999]) {
      const a = invoiceDisplayAmounts({ amount, taxable_value: null, tax_amount: null, tax_rate: 18 }, null);
      expect(a.taxable + a.tax, `₹${amount}`).toBe(amount);
      expect(a.tax).toBeLessThan(a.taxable);
    }
  });

  it("backs the tax out of the gross when the invoice predates the frozen columns", () => {
    /* Migration 0116 added taxable_value/tax_amount; anything issued before it has
       nulls. The card asks for exactly this formula, and it is the one generate_invoice
       itself uses: round(gross * 100 / (100 + rate)). */
    const a = invoiceDisplayAmounts({ amount: 590000, taxable_value: null, tax_amount: null, tax_rate: 18 }, null);
    expect(a.taxable).toBe(500000);
    expect(a.tax).toBe(90000);
    expect(a.tax).toBe(590000 - Math.round(590000 * 100 / 118));
  });

  it("a zero-rated export invoice stays at zero rather than having 18% invented", () => {
    /* The nullish default is `?? 18`, so a stored 0 must survive it. If it did not, an
       export invoice issued under LUT would print GST that the seller never charged and
       never owes. */
    const a = invoiceDisplayAmounts({ amount: 500000, taxable_value: 500000, tax_amount: 0, tax_rate: 0 }, null);
    expect(a.tax).toBe(0);
    expect(a.taxable).toBe(500000);
  });

  it("the PDF's Subtotal line cannot contradict its Taxable line", () => {
    /* A second symptom of the same bug, and the one a customer would have queried. The
       dialog already preferred the frozen taxable (`invoice.taxable_value ?? …`) but took
       `subtotal` straight from the page — so the downloaded PDF read Subtotal ₹5,90,000,
       Taxable ₹5,00,000, Total ₹5,90,000: three numbers, no arithmetic that joins them.
       With no quote there is no discount, so the two must be equal. */
    const a = invoiceDisplayAmounts(REPORTED, null);
    expect(a.subtotal).toBe(a.taxable);
    expect(a.discount).toBe(0);
    expect(a.subtotal - a.discount + a.tax).toBe(a.total);
  });

  it("a frozen split that disagrees with the rate is still what gets shown", () => {
    /* The issued document wins over anything recomputable. A stored split is what the
       customer was given and what the GST return already carries, so a mismatch is
       reported as it stands rather than silently corrected on screen. */
    const a = invoiceDisplayAmounts({ amount: 590000, taxable_value: 490000, tax_amount: 100000, tax_rate: 18 }, null);
    expect(a.taxable).toBe(490000);
    expect(a.tax).toBe(100000);
  });
});

describe("an invoice that does have a quote", () => {
  const quote = { subtotal: 500000, discount_pct: 0, tax_rate: 18, amount: 590000 };

  it("is unchanged by this fix", () => {
    /* Said out loud: the ordinary invoice does not move. A fix to a fallback that also
       shifted every normal document would be a much bigger change than the card asked
       for, and nobody would notice until a customer did. */
    const a = invoiceDisplayAmounts(REPORTED, quote);
    expect(a).toEqual({ subtotal: 500000, discountPct: 0, discount: 0, taxable: 500000, taxRate: 18, tax: 90000, total: 590000 });
  });

  it("keeps the discount line a quote-less invoice does not have", () => {
    const a = invoiceDisplayAmounts({ amount: 531000, taxable_value: 450000, tax_amount: 81000, tax_rate: 18 },
                                    { subtotal: 500000, discount_pct: 10, tax_rate: 18, amount: 531000 });
    expect(a.subtotal).toBe(500000);
    expect(a.discount).toBe(50000);
    expect(a.taxable).toBe(450000);
    expect(a.tax).toBe(81000);
  });
});

describe("/invoices no longer taxes the gross", () => {
  /* R-086: the invoice detail moved from a sheet in page.tsx to invoice-detail.tsx (its own page). */
  const src = readFileSync("src/app/(app)/invoices/invoice-detail.tsx", "utf8")
    /* Comments stripped — including trailing ones — so the prose explaining the removed
       expression cannot satisfy a scan for it (L46). */
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/(^|\s)\/\/[^\n]*/gm, "$1");

  it("the detail container asks the shared helper", () => {
    expect(src).toContain("invoiceDisplayAmounts(invoice, quote)");
  });

  it("nothing treats invoice.amount as a taxable subtotal any more", () => {
    /* The exact expression from the bug report. `total = quote?.amount ?? invoice.amount`
       is correct and stays — the gross IS the total — so this is anchored on `subtotal`. */
    expect(src).not.toMatch(/subtotal\s*=\s*quote\?\.subtotal\s*\?\?\s*invoice\.amount/);
    expect(src).not.toMatch(/Math\.round\(\s*taxable\s*\*\s*\(\s*taxRate\s*\/\s*100\s*\)\s*\)/);
  });
});

/* R-084 (1 Oct 2026): INV-FBB9-27-0005 — ₹600 line, 10% coupon. The screen now shows the
   discount row from these same numbers, so they must add up: 600 − 60 = 540, +97 = 637. */
describe("a coupon invoice shows its discount (R-084)", () => {
  const a = invoiceDisplayAmounts(
    { amount: 637, taxable_value: 540, tax_amount: 97, tax_rate: 18 },
    { subtotal: 600, discount_pct: 10, tax_rate: 18, amount: 637 },
  );
  it("discount, taxable and total add up", () => {
    expect(a.discount).toBe(60);
    expect(a.taxable).toBe(540);
    expect(a.subtotal - a.discount).toBe(a.taxable);
    expect(a.total).toBe(637);
  });
  it("the invoice screen renders a Discount row in its line-items table", () => {
    const src = readFileSync("src/app/(app)/invoices/invoice-detail.tsx", "utf8");
    expect(src).toMatch(/discount > 0 && \(\s*<tfoot/);
    expect(src).toMatch(/Taxable value/);
  });
});
