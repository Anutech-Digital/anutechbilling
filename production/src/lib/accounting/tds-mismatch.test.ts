import { describe, expect, it } from "vitest";
import {
  TDS_GST_NEXT_STEP,
  gstOnGross,
  tdsEffectiveRatePct,
  tdsMismatch,
} from "./tds-mismatch";

/* R-2047 — owner's real record (local DB, 24 Oct, SCN Bharat Apps, 194J): gross_amount 1,00,000
   (pre-GST taxable), tds_amount 11,800, rate_pct 10; invoice INV-…-0027 taxable 1,00,000,
   tax 18,000 @ 18%. The customer deducted 10% of ₹1,18,000 — the GST-inclusive amount. */
describe("R-2047 tdsMismatch — TDS that is not rate × gross", () => {
  it("matching TDS (10% of ₹1,00,000 = ₹10,000) → no note", () => {
    expect(tdsMismatch({ gross: 100_000, tds: 10_000, ratePct: 10, gst: 18_000 })).toBeNull();
  });

  it("₹1 rounding difference is not a mismatch", () => {
    expect(tdsMismatch({ gross: 2_075, tds: 208, ratePct: 10, gst: 374 })).toBeNull(); // 207.5
    expect(tdsMismatch({ gross: 2_070, tds: 208, ratePct: 10, gst: 373 })).toBeNull(); // 207 +1
    expect(tdsMismatch({ gross: 2_070, tds: 209, ratePct: "10.00", gst: null })).not.toBeNull(); // +2
  });

  it("owner's case — deducted on the GST-inclusive amount → the exact note", () => {
    const m = tdsMismatch({ gross: 100_000, tds: 11_800, ratePct: "10.00", gst: 18_000 });
    expect(m).not.toBeNull();
    expect(m!.kind).toBe("gst_inclusive");
    expect(m!.note).toBe(
      "Deducted ₹11,800 = 10% of ₹1,18,000 (incl. GST). On ₹1,00,000 it should be ₹10,000 — customer deducted ₹1,800 extra on GST.",
    );
    expect(m!.expected).toBe(10_000);
    expect(m!.extra).toBe(1_800);
    expect(m!.effectivePct).toBeCloseTo(11.8, 5);
    expect(m!.nextStep).toBe(TDS_GST_NEXT_STEP);
    expect(TDS_GST_NEXT_STEP).toBe("Ask the customer to deduct on the amount before GST next time");
  });

  it("other mismatch → the generic note, no GST next step", () => {
    const m = tdsMismatch({ gross: 100_000, tds: 9_000, ratePct: 10, gst: 18_000 });
    expect(m).toMatchObject({ kind: "other", expected: 10_000, nextStep: null });
    expect(m!.note).toBe("Expected ₹10,000 at 10% — deducted ₹9,000.");
  });

  it("GST unknown → the generic note even for 11,800", () => {
    const m = tdsMismatch({ gross: 100_000, tds: 11_800, ratePct: 10, gst: null });
    expect(m!.kind).toBe("other");
    expect(m!.note).toBe("Expected ₹10,000 at 10% — deducted ₹11,800.");
  });

  it("fractional rate prints as written (0.1%), and a 0 / missing gross gives no note", () => {
    const m = tdsMismatch({ gross: 1_000_000, tds: 5_000, ratePct: "0.10", gst: 0 });
    expect(m!.note).toBe("Expected ₹1,000 at 0.1% — deducted ₹5,000.");
    expect(tdsMismatch({ gross: 0, tds: 100, ratePct: 10, gst: 0 })).toBeNull();
  });
});

describe("R-2047 tdsEffectiveRatePct", () => {
  it("11,800 on 1,00,000 → 11.80; null when it equals the rate or gross is 0", () => {
    expect(tdsEffectiveRatePct(100_000, 11_800, 10)).toBeCloseTo(11.8, 5);
    expect(tdsEffectiveRatePct(100_000, 10_000, 10)).toBeNull();
    expect(tdsEffectiveRatePct(2_075, 208, 10)).toBeNull(); // rounding, within ₹1
    expect(tdsEffectiveRatePct(0, 10, 10)).toBeNull();
  });
});

describe("R-2047 gstOnGross — the GST on this entry's gross, from its invoice", () => {
  it("gross = invoice taxable value → the invoice's own tax amount", () => {
    expect(gstOnGross(100_000, { taxable_value: 100_000, tax_amount: 18_000, tax_rate: 18 })).toBe(18_000);
  });
  it("part payment → gross × the invoice's tax rate", () => {
    expect(gstOnGross(50_000, { taxable_value: 100_000, tax_amount: 18_000, tax_rate: 18 })).toBe(9_000);
    expect(gstOnGross(10_000, { taxable_value: 20_000, tax_amount: 1_000, tax_rate: "5.00" })).toBe(500);
  });
  it("no invoice or no rate → null (unknown)", () => {
    expect(gstOnGross(100_000, null)).toBeNull();
    expect(gstOnGross(100_000, { taxable_value: 90_000, tax_amount: null, tax_rate: null })).toBeNull();
  });
});
