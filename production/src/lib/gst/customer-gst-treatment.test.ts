/**
 * R-1736 — a customer's GST treatment (Zoho-style), the SEZ tax rule and PAN from GSTIN.
 * The first three tests are the owner's own examples from the card.
 */
import { describe, it, expect } from "vitest";
import { isInterStateSupply, supplyHead } from "./place-of-supply";
import {
  suggestGstTreatment, panFromGstin, nextGstTreatment, gstTreatmentOption,
  GST_TREATMENT_OPTIONS, gstTreatmentProblem, isValidPan,
} from "./customer-gst-treatment";
import { quotePlaceOfSupply, gstHeadLabel } from "@/lib/quotes/quote-place-of-supply";
import { lutMissingWarning } from "./export-lut";

const DELHI_SELLER = { state_code: "07", gstin: null };
// A checksum-valid Delhi GSTIN (the card's 07AAACR5055K1Z5 fails the checksum; Z9 is the valid one).
const DELHI_GSTIN = "07AAACR5055K1Z9";

describe("owner examples (card R-1736)", () => {
  it("Delhi GSTIN, Regular, we are in Delhi → CGST 9% + SGST 9%", () => {
    const pos = quotePlaceOfSupply({
      customer: { state_code: "07", gstin: DELHI_GSTIN, country: "India", gst_treatment: "registered_regular" },
      seller: DELHI_SELLER,
    });
    expect(pos.interState).toBe(false);
    expect(pos.label).toBe("Delhi (07) · CGST + SGST");
    expect(gstHeadLabel({ ratePct: 18, interState: pos.interState, isExport: pos.isExport })).toBe("CGST 9% + SGST 9%");
  });

  it("Delhi GSTIN, SEZ with payment, we are in Delhi → IGST 18%", () => {
    const pos = quotePlaceOfSupply({
      customer: { state_code: "07", gstin: DELHI_GSTIN, country: "India", gst_treatment: "sez_with_payment" },
      seller: DELHI_SELLER,
    });
    expect(pos.interState).toBe(true);
    expect(pos.head.kind).toBe("inter_state");
    expect(pos.label).toBe("Delhi (07) · IGST");
    expect(gstHeadLabel({ ratePct: 18, interState: pos.interState, isExport: pos.isExport })).toBe("IGST 18%");
  });

  it("SEZ without payment is inter-state too (IGST until Hitesh's LUT rule)", () => {
    expect(isInterStateSupply("07", "07", { treatment: "sez_without_payment" })).toBe(true);
  });

  it("US customer, no LUT on file → today an export at 0% with the LUT-missing warning (Hitesh's rule pending)", () => {
    const pos = quotePlaceOfSupply({
      customer: { country: "United States", gst_treatment: "overseas" },
      seller: DELHI_SELLER,
    });
    expect(pos.isExport).toBe(true);
    expect(lutMissingWarning({ taxRate: 0, lutNumber: null })).toMatch(/IGST is payable/);
  });
});

describe("isInterStateSupply / supplyHead with a treatment", () => {
  it("regular, composition, unregistered and consumer keep the state rule", () => {
    for (const t of ["registered_regular", "registered_composition", "unregistered_business", "consumer", "deemed_export"] as const) {
      expect(isInterStateSupply("07", "07", { treatment: t })).toBe(false);
      expect(isInterStateSupply("27", "07", { treatment: t })).toBe(true);
    }
  });
  it("no treatment = today's behaviour", () => {
    expect(isInterStateSupply("07", "07")).toBe(false);
    expect(isInterStateSupply("07", "07", { treatment: null })).toBe(false);
  });
  it("supplyHead: SEZ in the seller's state is a known inter-state head", () => {
    expect(supplyHead({ isExport: false, buyerStateCode: "07", sellerStateCode: "07", treatment: "sez_with_payment" }))
      .toEqual({ kind: "inter_state", known: true, interState: true });
  });
  it("supplyHead: SEZ still needs the company's own state (the invoice refuses without it)", () => {
    expect(supplyHead({ isExport: false, buyerStateCode: "07", sellerStateCode: null, treatment: "sez_with_payment" }).kind)
      .toBe("seller_state_missing");
  });
});

describe("suggestGstTreatment — the backfill rule and the form's auto-pick", () => {
  it("country not India → overseas (even with a GSTIN typed)", () => {
    expect(suggestGstTreatment({ country: "United States", gstin: null, customerType: "business" })).toBe("overseas");
    expect(suggestGstTreatment({ country: "Singapore", gstin: DELHI_GSTIN, customerType: "individual" })).toBe("overseas");
  });
  it("GSTIN present → registered_regular", () => {
    expect(suggestGstTreatment({ country: "India", gstin: DELHI_GSTIN, customerType: "business" })).toBe("registered_regular");
  });
  it("business without GSTIN → unregistered_business", () => {
    expect(suggestGstTreatment({ country: "India", gstin: "", customerType: "business" })).toBe("unregistered_business");
    expect(suggestGstTreatment({ country: null, gstin: null, customerType: null })).toBe("unregistered_business");
  });
  it("individual without GSTIN → consumer", () => {
    expect(suggestGstTreatment({ country: "India", gstin: null, customerType: "individual" })).toBe("consumer");
  });
});

describe("nextGstTreatment — auto-picked until the user chooses", () => {
  it("follows the suggestion while not chosen by hand", () => {
    expect(nextGstTreatment({ current: "unregistered_business", manual: false, suggestion: "registered_regular" })).toBe("registered_regular");
  });
  it("keeps a hand-picked SEZ when the GSTIN is typed", () => {
    expect(nextGstTreatment({ current: "sez_with_payment", manual: true, suggestion: "registered_regular" })).toBe("sez_with_payment");
  });
  it("a hand-picked domestic treatment gives way when the country leaves India", () => {
    expect(nextGstTreatment({ current: "sez_with_payment", manual: true, suggestion: "overseas" })).toBe("overseas");
  });
});

describe("gstTreatmentProblem — the form refuses a treatment the facts contradict", () => {
  it("registered / SEZ need a GSTIN", () => {
    expect(gstTreatmentProblem({ treatment: "registered_regular", country: "India", gstin: "" })).toMatch(/GSTIN/);
    expect(gstTreatmentProblem({ treatment: "sez_with_payment", country: "India", gstin: DELHI_GSTIN })).toBeNull();
  });
  it("overseas only outside India, and nothing else outside India", () => {
    expect(gstTreatmentProblem({ treatment: "overseas", country: "India", gstin: "" })).toMatch(/outside India/);
    expect(gstTreatmentProblem({ treatment: "consumer", country: "Germany", gstin: "" })).toMatch(/Overseas/);
  });
});

describe("panFromGstin", () => {
  it("characters 3–12 of a valid GSTIN", () => {
    expect(panFromGstin(DELHI_GSTIN)).toBe("AAACR5055K");
    expect(panFromGstin("07abdca0298h1zp")).toBe("ABDCA0298H");
  });
  it("null for an invalid or missing GSTIN — a typo never invents a PAN", () => {
    expect(panFromGstin("07AAACR5055K1Z5")).toBeNull(); // bad checksum
    expect(panFromGstin("")).toBeNull();
    expect(panFromGstin(null)).toBeNull();
  });
  it("isValidPan", () => {
    expect(isValidPan("AAACR5055K")).toBe(true);
    expect(isValidPan("AAACR5055")).toBe(false);
  });
});

describe("labels", () => {
  it("every treatment has a label and a one-line meaning", () => {
    expect(GST_TREATMENT_OPTIONS).toHaveLength(8);
    for (const o of GST_TREATMENT_OPTIONS) { expect(o.label).toBeTruthy(); expect(o.meaning).toBeTruthy(); }
    expect(gstTreatmentOption("registered_regular")?.label).toBe("Registered Business – Regular");
    expect(gstTreatmentOption("sez_with_payment")?.label).toBe("SEZ (with payment)");
  });
});
