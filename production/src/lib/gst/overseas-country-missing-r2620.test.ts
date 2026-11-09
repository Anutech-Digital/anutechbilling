/**
 * R-2620 — a customer marked Overseas with no country (or India) reads as India (G5): a new quote was
 * priced at 18% and previewed "Intra-state (CGST + SGST)" instead of being held until the country is
 * picked. SQL side: supabase/tests/r2620_overseas_needs_country.test.sql.
 */
import { describe, expect, it } from "vitest";
import { overseasCountryMissing, supplyHead } from "./place-of-supply";
import { OVERSEAS_NO_COUNTRY_LABEL, quotePlaceOfSupply } from "@/lib/quotes/quote-place-of-supply";

describe("R-2620 overseasCountryMissing", () => {
  it("is true for Overseas with an empty / blank / India country", () => {
    expect(overseasCountryMissing({ treatment: "overseas", country: null })).toBe(true);
    expect(overseasCountryMissing({ treatment: "overseas", country: "  " })).toBe(true);
    expect(overseasCountryMissing({ treatment: "overseas", country: "India" })).toBe(true);
    expect(overseasCountryMissing({ treatment: "overseas", country: "IN" })).toBe(true);
  });
  it("is false for Overseas with a foreign country, and for every Indian treatment", () => {
    expect(overseasCountryMissing({ treatment: "overseas", country: "United States" })).toBe(false);
    expect(overseasCountryMissing({ treatment: "unregistered_business", country: "" })).toBe(false);
    expect(overseasCountryMissing({ treatment: "sez_without_payment", country: "" })).toBe(false);
    expect(overseasCountryMissing({ treatment: null, country: "" })).toBe(false);
  });
});

describe("R-2620 supplyHead for Overseas with no country", () => {
  it("is not known (blocks the send / invoice) even when a state is on file", () => {
    const h = supplyHead({ isExport: false, buyerStateCode: "27", sellerStateCode: "07", treatment: "overseas" });
    expect(h).toEqual({ kind: "buyer_country_missing", known: false, interState: false });
  });
  it("the company's own state still comes first", () => {
    expect(supplyHead({ isExport: false, buyerStateCode: null, sellerStateCode: null, treatment: "overseas" }).kind)
      .toBe("seller_state_missing");
  });
  it("an Overseas customer WITH its country stays an export", () => {
    expect(supplyHead({ isExport: true, buyerStateCode: null, sellerStateCode: "07", treatment: "overseas" }).kind).toBe("export");
  });
  it("a domestic customer is unchanged", () => {
    expect(supplyHead({ isExport: false, buyerStateCode: "07", sellerStateCode: "07", treatment: "unregistered_business" }).kind)
      .toBe("intra_state");
  });
});

describe("R-2620 quote place of supply line", () => {
  it("never prints Intra-state for Overseas with no country", () => {
    const pos = quotePlaceOfSupply({
      customer: { state_code: null, gstin: null, country: "", gst_treatment: "overseas" },
      seller: { state_code: "07" },
    });
    expect(pos.head.kind).toBe("buyer_country_missing");
    expect(pos.label).toBe(OVERSEAS_NO_COUNTRY_LABEL);
    expect(pos.label).not.toMatch(/Intra-state|CGST/);
  });
  it("Overseas with its country still reads as an export", () => {
    const pos = quotePlaceOfSupply({
      customer: { state_code: null, gstin: null, country: "United States", gst_treatment: "overseas" },
      seller: { state_code: "07" },
    });
    expect(pos.isExport).toBe(true);
    expect(pos.label).toMatch(/^Export · United States/);
  });
});
