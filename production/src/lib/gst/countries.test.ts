/**
 * R-2180 — the customer "Country" list is the full ISO 3166-1 list, not ~60 hand-picked
 * names. Owner's cases (R-2094 runs): Woollyes OU (Estonia) and Zynk Labs (Cayman Islands)
 * could not be added because their country was not in the list.
 */
import { describe, it, expect } from "vitest";
import { COUNTRIES, normalizeCountry, searchCountries } from "./countries";
import { isExportSupply, gstTreatment } from "./place-of-supply";
import { suggestGstTreatment } from "./customer-gst-treatment";

describe("COUNTRIES — full ISO 3166-1 list (R-2180)", () => {
  it("has the owner's blocked countries and the rest of the world", () => {
    for (const c of ["Estonia", "Cayman Islands", "Bangladesh", "Latvia", "Lithuania", "Cyprus", "British Virgin Islands", "Seychelles", "Zimbabwe", "Ukraine"]) {
      expect(COUNTRIES).toContain(c);
    }
    expect(COUNTRIES.length).toBeGreaterThanOrEqual(245);
  });

  it("India is first, no duplicates", () => {
    expect(COUNTRIES[0]).toBe("India");
    expect(new Set(COUNTRIES).size).toBe(COUNTRIES.length);
  });

  it("keeps every name saved by the old list (saved rows stay valid)", () => {
    const OLD = ["India","United Arab Emirates","Saudi Arabia","Kuwait","Qatar","Oman","Bahrain","United States","United Kingdom","Canada","Australia","New Zealand","Singapore","Ireland","Bangladesh","Sri Lanka","Nepal","Bhutan","Maldives","Malaysia","Indonesia","Thailand","Vietnam","Philippines","Hong Kong","China","Japan","South Korea","Germany","France","Netherlands","Spain","Italy","Switzerland","Sweden","Belgium","Poland","Portugal","Denmark","Norway","Finland","South Africa","Nigeria","Kenya","Egypt","Mauritius","Mexico","Brazil","Argentina"];
    for (const c of OLD) expect(COUNTRIES).toContain(c);
    // The common export markets stay on top, in the old order.
    expect(COUNTRIES.slice(0, 14)).toEqual(OLD.slice(0, 14));
  });

  it("is the whole ISO 3166-1 list: 249 entries", () => {
    expect(COUNTRIES.length).toBe(249);
  });

  it("every country except India is an export (overseas, GST 0)", () => {
    for (const c of COUNTRIES.slice(1)) {
      expect(isExportSupply(c), c).toBe(true);
      expect(suggestGstTreatment({ country: c, gstin: "", customerType: "business" }), c).toBe("overseas");
    }
    expect(gstTreatment("Estonia", null, "07")).toBe("export");
  });
});

describe("normalizeCountry — old values and codes map to the list name (R-2180)", () => {
  it("aliases and ISO codes", () => {
    expect(normalizeCountry("USA")).toBe("United States");
    expect(normalizeCountry("US")).toBe("United States");
    expect(normalizeCountry("UK")).toBe("United Kingdom");
    expect(normalizeCountry("UAE")).toBe("United Arab Emirates");
    expect(normalizeCountry("EE")).toBe("Estonia");
    expect(normalizeCountry("KY")).toBe("Cayman Islands");
    expect(normalizeCountry("IN")).toBe("India");
    expect(normalizeCountry("Bharat")).toBe("India");
  });

  it("case and spaces do not matter; unknown text is kept as typed", () => {
    expect(normalizeCountry("  estonia ")).toBe("Estonia");
    expect(normalizeCountry("cayman islands")).toBe("Cayman Islands");
    expect(normalizeCountry("Atlantis")).toBe("Atlantis");
    expect(normalizeCountry("")).toBe("");
  });
});

describe("searchCountries — type a few letters (R-2180)", () => {
  it('"Est" finds Estonia first', () => {
    expect(searchCountries("Est")[0]).toBe("Estonia");
  });

  it('"cay" finds Cayman Islands; a code finds its country', () => {
    expect(searchCountries("cay")).toContain("Cayman Islands");
    expect(searchCountries("usa")[0]).toBe("United States");
  });

  it("accents are ignored", () => {
    expect(searchCountries("cote")).toContain("Côte d'Ivoire");
    expect(searchCountries("curacao")).toContain("Curaçao");
  });

  it("an empty search returns the whole list, India first", () => {
    const all = searchCountries("");
    expect(all.length).toBe(COUNTRIES.length);
    expect(all[0]).toBe("India");
  });
});
