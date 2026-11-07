/* R-2560 (7 Nov 2026, paisa) — follow-up of R-2556. On the FIRST payment of a quote, when the owner
   types a bank amount SMALLER than the balance, the desk Record payment sheet still took the default TDS
   on the whole balance (rate × the whole document's taxable) — TDS receivable too high.
   Rule: default TDS = rate × the taxable share of (this payment's money + TDS) — the same part rule as
   R-2556's tdsDefaultForPart / R-2551's tdsPartGross — recomputed whenever the bank amount changes.
   A TDS amount the owner typed by hand is never overridden. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tdsDefaultForPart, tdsPartGross } from "@/lib/accounting/tds-receipt";

const quote = { taxable: 10_000, total: 11_800 }; // ₹11,800 incl. 18% GST

describe("R-2560 tdsDefaultForPart with the money typed for this payment", () => {
  it("₹11,800 quote, first payment ₹5,000 in bank at 2% → TDS only on that part (₹86), not ₹200", () => {
    const r = tdsDefaultForPart({ remaining: 11_800, ...quote, ratePct: 2, bookedTds: 0, money: 5_000 });
    expect(r.tds).toBe(86);
    // the part is the money + its TDS: ₹5,086 → taxable ₹4,310 → 2% = ₹86 (a fixed point)
    expect(r.partTaxable).toBe(4_310);
    expect(tdsPartGross({ paid: 5_000 + r.tds, ...quote, tds: 0, ratePct: null })).toBe(r.partTaxable);
  });
  it("same at 10% (194J): ₹5,000 in bank → ₹463 TDS on ₹4,630, not ₹1,000", () => {
    const r = tdsDefaultForPart({ remaining: 11_800, ...quote, ratePct: 10, bookedTds: 0, money: 5_000 });
    expect(r).toEqual({ partTaxable: 4_630, tds: 463 });
  });
  it("full payment is unchanged: money = balance − whole TDS → rate × the whole taxable", () => {
    expect(tdsDefaultForPart({ remaining: 11_800, ...quote, ratePct: 2, bookedTds: 0, money: 11_600 }))
      .toEqual({ partTaxable: 10_000, tds: 200 });
    // no money given (bank not typed) → the balance rule of R-2556, exactly as before
    expect(tdsDefaultForPart({ remaining: 11_800, ...quote, ratePct: 2, bookedTds: 0 }))
      .toEqual({ partTaxable: 10_000, tds: 200 });
    expect(tdsDefaultForPart({ remaining: 11_800, ...quote, ratePct: 2, bookedTds: 0, money: null }))
      .toEqual({ partTaxable: 10_000, tds: 200 });
  });
  it("R-2095 ₹1 rounding: bank ₹1 short / over the full-payment amount still takes the whole TDS", () => {
    expect(tdsDefaultForPart({ remaining: 11_800, ...quote, ratePct: 2, bookedTds: 0, money: 11_599 }).tds).toBe(200);
    expect(tdsDefaultForPart({ remaining: 11_800, ...quote, ratePct: 2, bookedTds: 0, money: 11_601 }).tds).toBe(200);
    expect(tdsDefaultForPart({ remaining: 11_800, ...quote, ratePct: 2, bookedTds: 0, money: 20_000 }).tds).toBe(200);
  });
  it("money ₹0 or nothing typed → the balance rule (a TDS-only receipt is not cut to ₹0)", () => {
    expect(tdsDefaultForPart({ remaining: 11_800, ...quote, ratePct: 2, bookedTds: 0, money: 0 }).tds).toBe(200);
  });
  it("second part with a smaller bank amount: part of the money, still capped by the TDS already booked", () => {
    // half paid with ₹100 TDS booked; now ₹2,000 in bank → part ₹2,034 → taxable ₹1,724 → ₹34
    expect(tdsDefaultForPart({ remaining: 5_900, ...quote, ratePct: 2, bookedTds: 100, money: 2_000 }).tds).toBe(34);
    // the whole TDS already booked → ₹0 whatever the money
    expect(tdsDefaultForPart({ remaining: 5_900, ...quote, ratePct: 2, bookedTds: 200, money: 2_000 }).tds).toBe(0);
  });
  it("is always a fixed point: TDS = rate × taxable share of (money + TDS), for many amounts and rates", () => {
    for (const rate of [0.1, 0.125, 1, 2, 5, 10, 20]) {
      for (let money = 1; money < 11_000; money += 137) {
        const r = tdsDefaultForPart({ remaining: 11_800, ...quote, ratePct: rate, bookedTds: 0, money });
        const full = tdsDefaultForPart({ remaining: 11_800, ...quote, ratePct: rate, bookedTds: 0 }).tds;
        if (money + full >= 11_800 - 1) { expect(r.tds).toBe(full); continue; }
        const part = tdsPartGross({ paid: money + r.tds, ...quote, tds: 0, ratePct: null });
        expect(r.partTaxable).toBe(part);
        expect(r.tds).toBe(Math.round(part * rate / 100 + 1e-9));
        expect(r.tds).toBeLessThanOrEqual(full);
      }
    }
  });
});

describe("R-2560 desk Record payment sheet — default TDS follows the typed bank amount", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/components/features/quotes/record-payment-dialog.tsx"), "utf8");
  it("passes this payment's money (bank + advance) once the bank amount is typed", () => {
    expect(src).toMatch(/tdsDefaultForPart\(\{ remaining, taxable: quotePreGST, total: expectedAmount, ratePct: tdsRatePct, bookedTds, money: typedMoney \}\)/);
    expect(src).toMatch(/const typedMoney = amountEdited \? \(Number\(watchedAmount\) \|\| 0\) \+ appliedCreditAmount : null;/);
    expect(src).toMatch(/\[tdsDeducted, tdsOnly, quotePreGST, tdsRatePct, expectedAmount, quoteTaxRate, remaining, bookedTds, typedMoney\]/);
  });
  it("a TDS typed by hand is not reset when the bank amount changes", () => {
    expect(src).toMatch(/React\.useEffect\(\(\) => \{ setTypedPartTds\(null\); \}, \[open, tdsDeducted, tdsRatePct\]\);/);
    expect(src).toMatch(/const tdsAmount = tdsDeducted && typedPartTds !== null \? typedPartTds/);
  });
});
