/* R-2556 (7 Nov 2026, paisa) — the desk Record payment sheet's DEFAULT TDS was rate × the WHOLE
   document's pre-GST value, even when part of the bill was already paid: paying the second half booked
   the whole document's TDS again (TDS receivable too high, 26AS never matches).
   Rule: default TDS = rate × the taxable share of THIS payment's part (the balance it settles) — the
   same part rule as R-2551's tdsPartGross / SQL bank_credit_tds_gross — and never more than the
   document's TDS at that rate minus the TDS already booked on its earlier parts. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tdsDefaultForPart } from "@/lib/accounting/tds-receipt";

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
