import { describe, it, expect } from "vitest";
import { quoteDisplayTax } from "./quote-tax";
import { quoteAmounts } from "@/lib/pdf/build-props";
import { invoiceDisplayAmounts } from "@/lib/invoices/display-amounts";
import { splitTaxHeads } from "@/lib/gst/tax-split";
import { seatIncreaseCharge } from "@/lib/subscriptions/seat-increase-charge";

/** R-804: what every quote screen shows must add up to the stored total. */
const q = (subtotal: number, amount: number | null, discount_pct = 0, tax_rate = 18) =>
  ({ subtotal, amount, discount_pct, tax_rate });

describe("quoteDisplayTax (R-804)", () => {
  it("Q-F588-27-0006: ₹853 + ₹153 = ₹1,006 (was ₹154)", () => {
    const a = quoteAmounts(q(853, 1006));
    expect(a.tax).toBe(153);
    expect(a.taxable + a.tax).toBe(a.total);
    expect(a.total).toBe(1006);
  });

  it("Q-F588-27-0007: ₹1,543 + ₹277 = ₹1,820 (was ₹278)", () => {
    const a = quoteAmounts(q(1543, 1820));
    expect(a.tax).toBe(277);
    expect(a.taxable + a.tax).toBe(1820);
  });

  it("intra-state: CGST + SGST = GST, and the lines add to the total", () => {
    const a = quoteAmounts(q(853, 1006));
    const heads = splitTaxHeads(a.tax, false);
    expect(heads.igst).toBe(0);
    expect(heads.cgst + heads.sgst).toBe(a.tax);
    expect(a.taxable + heads.cgst + heads.sgst).toBe(1006);
    expect(heads).toEqual({ igst: 0, cgst: 77, sgst: 76 });
  });

  it("inter-state: IGST = GST, and the lines add to the total", () => {
    const a = quoteAmounts(q(1543, 1820));
    const heads = splitTaxHeads(a.tax, true);
    expect(heads).toEqual({ igst: 277, cgst: 0, sgst: 0 });
    expect(a.taxable + heads.igst).toBe(1820);
  });

  it("matches R-803's seat charge (GST = total − subtotal) on the quotes it writes", () => {
    // ₹1,656/seat/yr (mrr 138 × 12), 1 seat, 188 of 365 days → ₹853 / ₹1,006
    const c = seatIncreaseCharge({ currentSeats: 1, currentMrr: 138, additionalSeats: 1, remainingDays: 188, termDays: 365, taxRatePct: 18 });
    expect(quoteDisplayTax(c.subtotal, 18, c.total)).toBe(c.tax);
  });

  it("an ordinary quote (total = taxable + rounded GST) is unchanged", () => {
    expect(quoteDisplayTax(10_000, 18, 11_800)).toBe(1_800);
    expect(quoteDisplayTax(999, 18, 999 + 180)).toBe(180);
  });

  it("with a discount the GST still closes the gap to the total", () => {
    const a = quoteAmounts(q(1000, 1002, 15)); // taxable 850, worked GST 153 (1,003), stored 1,002
    expect(a.taxable).toBe(850);
    expect(a.tax).toBe(152);
    expect(a.taxable + a.tax).toBe(1002);
  });

  it("no stored total → the worked-out GST", () => {
    expect(quoteDisplayTax(853, 18, null)).toBe(154);
    expect(quoteAmounts(q(853, null)).total).toBe(1007);
  });

  it("zero-rated export: no GST", () => {
    expect(quoteDisplayTax(853, 0, 853)).toBe(0);
  });

  it("a stored total that is wrong by more than rounding is NOT hidden inside GST", () => {
    // subtotal 0 with an ₹8,20,000 total (old seed rows) — GST must not read ₹8,20,000
    expect(quoteDisplayTax(0, 18, 820_000)).toBe(0);
    expect(quoteDisplayTax(10_000, 18, 11_900)).toBe(1_800);
  });

  it("invoice detail/PDF built from the quote add up too", () => {
    const a = invoiceDisplayAmounts({ amount: 1006, taxable_value: 853, tax_amount: 153, tax_rate: 18 }, q(853, 1006));
    expect(a.taxable + a.tax).toBe(a.total);
    expect(a.tax).toBe(153);
  });
});
