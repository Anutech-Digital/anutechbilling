import { describe, it, expect } from "vitest";
import { checkTdsRate, defaultTds, tdsBase, tdsDefaultRatePct, TDS_RATE_VARIANTS, TDS_SECTION_RATES } from "./tds-rates";

describe("R-523 section default rate — what the drawer sets when the section changes", () => {
  it("194C → 2, 194J → 10 (the single table), unknown → null", () => {
    expect(tdsDefaultRatePct("194C")).toBe(2);
    expect(tdsDefaultRatePct("194J")).toBe(10);
    expect(tdsDefaultRatePct(" 194h ")).toBe(TDS_SECTION_RATES["194H"].ratePct);
    expect(tdsDefaultRatePct("192")).toBeNull();
    expect(tdsDefaultRatePct(null)).toBeNull();
  });

  it("a rate kept at 10 after switching to 194C warns firmly", () => {
    const c = checkTdsRate("194C", 10);
    expect(c).toMatchObject({ matches: false, defaultPct: 2, knownVariant: false });
    expect(c.message).toBe("194C is 2%, not 10%. Check the section or the rate before saving.");
  });

  it("the section's other lawful rate warns softly; the default does not warn", () => {
    expect(checkTdsRate("194C", 1)).toMatchObject({ matches: false, knownVariant: true });
    expect(checkTdsRate("194J", 2).message).toBe("194J is usually 10%. 2% is right only for technical services (not professional fees).");
    expect(checkTdsRate("194J", 10)).toMatchObject({ matches: true, message: null });
    expect(checkTdsRate("194C", Number("2.00")).matches).toBe(true);
  });

  it("every variant names a section the table knows, and differs from its default", () => {
    for (const [sec, vs] of Object.entries(TDS_RATE_VARIANTS)) {
      expect(TDS_SECTION_RATES[sec]).toBeDefined();
      for (const v of vs) expect(v.ratePct).not.toBe(TDS_SECTION_RATES[sec].ratePct);
    }
  });
});

describe("default TDS per section", () => {
  it("194H commission at 2%: ₹5,00,000 → ₹10,000", () => {
    expect(defaultTds("194H", 5_00_000)).toBe(10_000);
  });

  it("194J 10%, 194C 2%, 194I 10%, 194A 10%, 194Q 0.1%", () => {
    expect(defaultTds("194J", 1_00_000)).toBe(10_000);
    expect(defaultTds("194C", 1_00_000)).toBe(2_000);
    expect(defaultTds("194I", 50_000)).toBe(5_000);
    expect(defaultTds("194A", 12_345)).toBe(1_235);
    expect(defaultTds("194Q", 60_00_000)).toBe(6_000);
  });

  it("an unknown section has no default — the operator types it", () => {
    expect(defaultTds("192", 1_00_000)).toBeNull();
    expect(defaultTds("", 1_00_000)).toBeNull();
  });

  it("the other rate is named where a section has two", () => {
    expect(TDS_SECTION_RATES["194C"].note).toMatch(/1%/);
    expect(TDS_SECTION_RATES["194J"].note).toMatch(/2%/);
  });
});

describe("tdsBase — TDS is on the value before GST", () => {
  it("a ₹1,18,000 bill with ₹18,000 GST → base ₹1,00,000", () => {
    expect(tdsBase(1_18_000, 18_000)).toBe(1_00_000);
  });
  it("no GST → the whole amount; never negative", () => {
    expect(tdsBase(5_00_000, 0)).toBe(5_00_000);
    expect(tdsBase(100, 500)).toBe(0);
  });
});
