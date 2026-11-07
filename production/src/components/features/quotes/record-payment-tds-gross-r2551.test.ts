/* R-2551 (7 Nov 2026, p1 money) — the desk Record payment sheet sent the WHOLE document's pre-GST value
   (quotePreGST) as the TDS gross, even on a part payment; R-2538 fixed the bank-reconcile path only.
   The rule (R-2538's SQL helpers bank_credit_tds_part_gross / bank_credit_tds_gross, twinned in
   tdsPartGross): gross = (money + TDS) × taxable ÷ GST-inclusive total, never above the taxable; a
   given rate the TDS does not fit on the part → TDS × 100 ÷ rate (capped); never null.
   The SQL side (record_multi_invoice_payment) is proven in supabase/tests/r2551_tds_gross_desk_multi.test.sql. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tdsPartGross } from "@/lib/accounting/tds-receipt";

describe("R-2551 tdsPartGross — same answers as R-2538's bank_credit_tds_gross", () => {
  it("staging case: half-yearly part ₹91,350 + ₹1,575 TDS of a ₹1,85,850 year → gross ₹78,750, not ₹1,57,500", () => {
    expect(tdsPartGross({ paid: 92_925, taxable: 1_57_500, total: 1_85_850, tds: 1_575, ratePct: 2 })).toBe(78_750);
  });
  it("half of an ₹11,800 invoice (₹5,800 + ₹100 TDS 2%) → ₹5,000", () => {
    expect(tdsPartGross({ paid: 5_900, taxable: 10_000, total: 11_800, tds: 100, ratePct: 2 })).toBe(5_000);
  });
  it("no rate → the part's taxable (the rate is worked out from it later)", () => {
    expect(tdsPartGross({ paid: 5_900, taxable: 10_000, total: 11_800, tds: 100, ratePct: null })).toBe(5_000);
    expect(tdsPartGross({ paid: 5_900, taxable: 10_000, total: 11_800, tds: 100, ratePct: 0 })).toBe(5_000);
  });
  it("the whole document paid (or more) → the whole taxable", () => {
    expect(tdsPartGross({ paid: 11_800, taxable: 10_000, total: 11_800, tds: 200, ratePct: 2 })).toBe(10_000);
    expect(tdsPartGross({ paid: 12_000, taxable: 10_000, total: 11_800, tds: 200, ratePct: 2 })).toBe(10_000);
  });
  it("customer deducted on the WHOLE document from a part → TDS × 100 ÷ rate (what 26AS shows), capped", () => {
    expect(tdsPartGross({ paid: 5_900, taxable: 10_000, total: 11_800, tds: 200, ratePct: 2 })).toBe(10_000);
    expect(tdsPartGross({ paid: 5_900, taxable: 10_000, total: 11_800, tds: 500, ratePct: 2 })).toBe(10_000);
    expect(tdsPartGross({ paid: 2_950, taxable: 10_000, total: 11_800, tds: 100, ratePct: 10 })).toBe(1_000);
  });
  it("±₹1 is TDS rounding, not a different base", () => {
    expect(tdsPartGross({ paid: 5_901, taxable: 10_000, total: 11_800, tds: 101, ratePct: 2 })).toBe(5_001);
    expect(tdsPartGross({ paid: 5_899, taxable: 10_000, total: 11_800, tds: 99, ratePct: 2 })).toBe(4_999);
  });
  it("odd rates stay exact (7.5%, 0.1%)", () => {
    // ₹10,750 + TDS of a ₹11,800 / ₹10,000 doc: part 10,000 → 7.5% = 750 fits
    expect(tdsPartGross({ paid: 11_800, taxable: 10_000, total: 11_800, tds: 750, ratePct: 7.5 })).toBe(10_000);
    // 0.1% of the whole ₹10,000 = ₹10 kept from a half part → TDS × 100 ÷ 0.1 = ₹10,000
    expect(tdsPartGross({ paid: 5_900, taxable: 10_000, total: 11_800, tds: 10, ratePct: 0.1 })).toBe(10_000);
  });
  it("never null: no taxable → 0; no usable total → the taxable; nothing paid → 0", () => {
    expect(tdsPartGross({ paid: 5_900, taxable: 0, total: 11_800, tds: 100, ratePct: 2 })).toBe(0);
    expect(tdsPartGross({ paid: 5_900, taxable: null, total: 11_800, tds: 100, ratePct: 2 })).toBe(0);
    expect(tdsPartGross({ paid: 5_900, taxable: 10_000, total: 0, tds: 200, ratePct: 2 })).toBe(10_000);
    expect(tdsPartGross({ paid: 0, taxable: 10_000, total: 11_800, tds: 0, ratePct: 2 })).toBe(0);
  });
  it("crore-sized amounts round exactly (no float drift)", () => {
    // 3,33,33,333 of 11,80,00,000 at taxable 10,00,00,000 → 2,82,48,587.29 → 2,82,48,587
    expect(tdsPartGross({ paid: 3_33_33_333, taxable: 10_00_00_000, total: 11_80_00_000, tds: 0, ratePct: null })).toBe(2_82_48_587);
  });
});

describe("R-2551 desk Record payment sheet — sends the part's gross, not the whole document's", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/components/features/quotes/record-payment-dialog.tsx"), "utf8");
  it("p_tds_gross is tdsPartGross of what this receipt settles (money + TDS) against the document", () => {
    expect(src).not.toMatch(/p_tds_gross:\s*quotePreGST/);
    expect(src).toMatch(/p_tds_gross:\s*tdsGross,/);
    expect(src).toMatch(/const tdsGross = tdsPartGross\(\{ paid: settledAmount, taxable: quotePreGST, total: expectedAmount, tds: tdsAmount, ratePct: tdsRatePct \}\)/);
  });
});
