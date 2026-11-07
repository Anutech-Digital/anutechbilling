/* R-2556 (7 Nov 2026, paisa) — the desk Record payment sheet's DEFAULT TDS was rate × the WHOLE
   document's pre-GST value, even when part of the bill was already paid: paying the second half booked
   the whole document's TDS again (TDS receivable too high, 26AS never matches).
   Rule: default TDS = rate × the taxable share of THIS payment's part (the balance it settles) — the
   same part rule as R-2551's tdsPartGross / SQL bank_credit_tds_gross — and never more than the
   document's TDS at that rate minus the TDS already booked on its earlier parts. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { bookedTdsAtRate, tdsDefaultForPart } from "@/lib/accounting/tds-receipt";

describe("R-2556 tdsDefaultForPart — TDS only on this payment's part", () => {
  it("50% paid quote (₹5,900 of ₹11,800, TDS ₹100 booked) → second 50% pays TDS on ₹5,000 = ₹100, not ₹200", () => {
    const r = tdsDefaultForPart({ remaining: 5_900, taxable: 10_000, total: 11_800, ratePct: 2, bookedTds: 100 });
    expect(r.partTaxable).toBe(5_000);
    expect(r.tds).toBe(100);
  });
  it("same, while the booked TDS is not known yet → still only the part (₹100)", () => {
    expect(tdsDefaultForPart({ remaining: 5_900, taxable: 10_000, total: 11_800, ratePct: 2, bookedTds: null }).tds).toBe(100);
  });
  it("full payment (nothing paid before) is unchanged: rate × the whole taxable", () => {
    const r = tdsDefaultForPart({ remaining: 11_800, taxable: 10_000, total: 11_800, ratePct: 2, bookedTds: 0 });
    expect(r).toEqual({ partTaxable: 10_000, tds: 200 });
    expect(tdsDefaultForPart({ remaining: 1_52_928, taxable: 1_29_600, total: 1_52_928, ratePct: 2, bookedTds: 0 }).tds).toBe(2_592);
  });
  it("0.125% rate stays exact (half away from zero): ₹5,000 part → ₹6; ₹1,200 → ₹2 (1.5 rounds up)", () => {
    expect(tdsDefaultForPart({ remaining: 5_900, taxable: 10_000, total: 11_800, ratePct: 0.125, bookedTds: 6 }).tds).toBe(6);
    expect(tdsDefaultForPart({ remaining: 1_416, taxable: 1_200, total: 1_416, ratePct: 0.125, bookedTds: 0 }).tds).toBe(2);
  });
  it("TDS already booked on earlier parts is never added again (first half booked the whole ₹200 → ₹0 now)", () => {
    expect(tdsDefaultForPart({ remaining: 5_800, taxable: 10_000, total: 11_800, ratePct: 2, bookedTds: 200 }).tds).toBe(0);
    expect(tdsDefaultForPart({ remaining: 5_900, taxable: 10_000, total: 11_800, ratePct: 2, bookedTds: 150 }).tds).toBe(50);
  });
  it("no rate / no taxable / nothing left → ₹0", () => {
    expect(tdsDefaultForPart({ remaining: 5_900, taxable: 10_000, total: 11_800, ratePct: 0, bookedTds: 0 }).tds).toBe(0);
    expect(tdsDefaultForPart({ remaining: 5_900, taxable: 0, total: 11_800, ratePct: 2, bookedTds: 0 }).tds).toBe(0);
    expect(tdsDefaultForPart({ remaining: 0, taxable: 10_000, total: 11_800, ratePct: 2, bookedTds: 0 }).tds).toBe(0);
  });
});

describe("R-2556 bookedTdsAtRate — only TDS booked at the rate now typed counts", () => {
  const rows = [
    { tds_amount: 100, rate_pct: 2 },
    { tds_amount: 500, rate_pct: "10" },
    { tds_amount: 6, rate_pct: "0.125" },
    { tds_amount: null, rate_pct: 2 },
  ];
  it("sums rows at the same rate (number or numeric string), ignores others", () => {
    expect(bookedTdsAtRate(rows, 2)).toBe(100);
    expect(bookedTdsAtRate(rows, 10)).toBe(500);
    expect(bookedTdsAtRate(rows, 0.125)).toBe(6);
    expect(bookedTdsAtRate(rows, 1)).toBe(0);
    expect(bookedTdsAtRate([], 2)).toBe(0);
  });
  it("first half booked as 194J 10% (₹500), second half 194C 2% → ₹100 on this part, not ₹0", () => {
    const booked = bookedTdsAtRate([{ tds_amount: 500, rate_pct: 10 }], 2);
    expect(tdsDefaultForPart({ remaining: 5_900, taxable: 10_000, total: 11_800, ratePct: 2, bookedTds: booked }).tds).toBe(100);
  });
});

describe("R-2556 desk Record payment sheet — default TDS from the part, not the whole quote", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/components/features/quotes/record-payment-dialog.tsx"), "utf8");
  it("tdsAtRate comes from tdsDefaultForPart on the balance (remaining), with the TDS already booked", () => {
    expect(src).toMatch(/tdsDefaultForPart\(\{ remaining, taxable: quotePreGST, total: expectedAmount, ratePct: tdsRatePct, bookedTds/);
  });
  it("R-1520 'Record TDS' (tdsOnly: the leftover IS the whole document's TDS) keeps rate × the whole taxable", () => {
    expect(src).toMatch(/tdsOnly\s*\?\s*\{ partTaxable: quotePreGST, tds: computeTds\(expectedAmount, tdsRatePct, quoteTaxRate\)\.tds \}/);
  });
  it("reads the TDS already booked on this document, leaving reversed rows out", () => {
    const reads = src.match(/\.from\("tds_receivable"\)[^;]*;/g) ?? [];
    expect(reads.length).toBe(2);
    for (const r of reads) expect(r).toContain('.filter("status", "neq", TDS_REVERSED_STATUS)');
  });
});

describe("R-2556 desk sheet — saving a part payment with TDS", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/components/features/quotes/record-payment-dialog.tsx"), "utf8");
  it("waits for the booked TDS before saving, and a ₹0 TDS saves as a plain payment", () => {
    expect(src).toMatch(/bookedRows === "loading"\) \{\s*throw new Error\("Still reading the TDS already booked/);
    expect(src).toMatch(/const tdsActive = !!data\.tdsDeducted && tdsAmount > 0;/);
  });
  it("only booked TDS at the typed rate caps the default", () => {
    expect(src).toMatch(/bookedTdsAtRate\(bookedRows, tdsRatePct\)/);
  });
});
