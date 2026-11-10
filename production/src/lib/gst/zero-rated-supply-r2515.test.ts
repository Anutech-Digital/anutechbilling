/**
 * R-2515 — a supply to an SEZ unit WITHOUT payment of tax is zero-rated (0% GST under the LUT),
 * like an export. Owner's case (R-2094, May): an SEZ customer with a GSTIN
 * (Haryana), paid ₹55,223 against a Zoho invoice at 0% GST — the app could only
 * book it at IGST 18% because "SEZ (without payment)" was still taxed like "with payment".
 */
import { describe, it, expect } from "vitest";
import { isZeroRatedSupply } from "./place-of-supply";
import { gstTreatmentOption } from "./customer-gst-treatment";
import { quoteEffectiveTaxRate } from "@/lib/quotes/bill-of-supply";
import { sezEndorsement, SEZ_WITHOUT_PAYMENT_ENDORSEMENT } from "./sez-endorsement";
import { auditInvoiceGst } from "./mismatch";

describe("R-2515: isZeroRatedSupply", () => {
  it("SEZ without payment of tax (Indian GSTIN) is 0%", () => {
    expect(isZeroRatedSupply({ country: "India", treatment: "sez_without_payment" })).toBe(true);
    expect(isZeroRatedSupply({ country: null, treatment: "sez_without_payment" })).toBe(true);
  });
  it("an export (customer abroad) is 0%, whatever its stored treatment", () => {
    expect(isZeroRatedSupply({ country: "Estonia", treatment: "overseas" })).toBe(true);
    expect(isZeroRatedSupply({ country: "Germany", treatment: "unregistered_business" })).toBe(true);
  });
  it("SEZ WITH payment, regular, unknown treatment and no country stay taxed", () => {
    expect(isZeroRatedSupply({ country: "India", treatment: "sez_with_payment" })).toBe(false);
    expect(isZeroRatedSupply({ country: "India", treatment: "registered_regular" })).toBe(false);
    expect(isZeroRatedSupply({ country: "India", treatment: "deemed_export" })).toBe(false);
    expect(isZeroRatedSupply({ country: "", treatment: null })).toBe(false);
    expect(isZeroRatedSupply({ country: undefined, treatment: undefined })).toBe(false);
  });
});

describe("R-2515: the quote rate for an SEZ-without-payment buyer", () => {
  it("is 0 (the zero-rated flag), and 18 for SEZ with payment", () => {
    expect(quoteEffectiveTaxRate({ saved: null, isExport: isZeroRatedSupply({ country: "India", treatment: "sez_without_payment" }), taxRate: 18 })).toBe(0);
    expect(quoteEffectiveTaxRate({ saved: null, isExport: isZeroRatedSupply({ country: "India", treatment: "sez_with_payment" }), taxRate: 18 })).toBe(18);
  });
});

describe("R-2515: words", () => {
  it("the SEZ (without payment) meaning says 0% under the LUT, not 'Charged IGST for now'", () => {
    const m = gstTreatmentOption("sez_without_payment")?.meaning ?? "";
    expect(m).not.toMatch(/for now|not set up/i);
    expect(m).toMatch(/0%/);
    expect(m).toMatch(/LUT/);
  });
  it("a 0% SEZ invoice prints the without-payment endorsement with the LUT ARN", () => {
    expect(sezEndorsement({ treatment: "sez_without_payment", tax: 0, lutNumber: "AD060426001234Z" }))
      .toEqual({ text: SEZ_WITHOUT_PAYMENT_ENDORSEMENT, lutArn: "AD060426001234Z" });
  });
});

describe("R-2515: the GST check on a 0% SEZ invoice", () => {
  const SELLER = { stateCode: "07", gstin: "07ABDCA0298H1ZP", country: "India" };
  it("a 0% IGST invoice to an SEZ unit without payment is clean (no 'not 18%' warning)", () => {
    const issues = auditInvoiceGst({ taxableValue: 55223, taxAmount: 0, taxRate: 0, interState: true, gstTreatment: "sez_without_payment" },
      { stateCode: "06", gstin: "06AAACS2515E1ZW" }, SELLER);
    expect(issues).toEqual([]);
  });
  it("a 0% invoice to a regular customer still warns", () => {
    const issues = auditInvoiceGst({ taxableValue: 55223, taxAmount: 0, taxRate: 0, interState: true, gstTreatment: "registered_regular" },
      { stateCode: "06" }, SELLER);
    expect(issues.map((i) => i.code)).toContain("unexpected_rate");
  });
});
