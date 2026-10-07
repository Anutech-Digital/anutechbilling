import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { EXPORT_LUT_ENDORSEMENT, exportEndorsement, lutMissingWarning, isZeroRatedExport } from "./export-lut";

describe("R-334 export endorsement (CGST Rule 46)", () => {
  it("is the exact statutory wording", () => {
    expect(EXPORT_LUT_ENDORSEMENT).toBe(
      "SUPPLY MEANT FOR EXPORT UNDER LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX",
    );
  });

  it("prints endorsement + LUT ARN on a zero-rated export", () => {
    expect(exportEndorsement({ isExport: true, tax: 0, lutNumber: " AD290425000000X " })).toEqual({
      text: EXPORT_LUT_ENDORSEMENT, lutArn: "AD290425000000X",
    });
  });

  it("prints the endorsement but no invented ARN when none is saved", () => {
    expect(exportEndorsement({ isExport: true, tax: 0, lutNumber: "" })).toEqual({
      text: EXPORT_LUT_ENDORSEMENT, lutArn: null,
    });
  });

  it("prints nothing on a domestic invoice or an export with IGST paid", () => {
    expect(exportEndorsement({ isExport: false, tax: 0, lutNumber: "X" })).toBeNull();
    expect(exportEndorsement({ isExport: true, tax: 1800, lutNumber: "X" })).toBeNull();
    expect(isZeroRatedExport({ isExport: false, tax: 1800 })).toBe(false);
  });
});

describe("R-334 LUT-missing warning on issue", () => {
  it("warns for a 0% export with no LUT", () => {
    expect(lutMissingWarning({ taxRate: 0, lutNumber: null })).toMatch(/no LUT number/);
    expect(lutMissingWarning({ taxRate: 0, lutNumber: "   " })).toMatch(/RFD-11/);
  });
  it("is silent when an LUT is saved or the invoice carries GST", () => {
    expect(lutMissingWarning({ taxRate: 0, lutNumber: "AD290425000000X" })).toBeNull();
    expect(lutMissingWarning({ taxRate: 18, lutNumber: null })).toBeNull();
    expect(lutMissingWarning({ taxRate: null, lutNumber: null })).toBeNull();
  });
});

describe("R-334 wiring", () => {
  const pdf = readFileSync("src/lib/pdf/InvoicePDF.tsx", "utf8");
  it("InvoicePDF renders the endorsement from the helper", () => {
    expect(pdf).toMatch(/exportEndorsement\(/);
    expect(pdf).toMatch(/LUT ARN/);
  });
  it("both invoice PDF paths pass the seller's LUT", () => {
    expect(readFileSync("src/lib/pdf/build-props.ts", "utf8")).toMatch(/lutNumber:\s+tenant\.lut_number/);
    expect(readFileSync("src/app/api/v1/documents/invoice/[id]/pdf/route.ts", "utf8")).toMatch(/lut_number/);
    expect(readFileSync("src/components/features/quotes/tax-invoice-dialog.tsx", "utf8")).toMatch(/lutNumber:\s*me\?\.tenantLutNumber/);
  });
  it("issuing an invoice warns (not blocks) when the LUT is missing", () => {
    const q = readFileSync("src/lib/queries/invoices.ts", "utf8");
    expect(q).toMatch(/lutMissingWarning\(/);
    expect(q).toMatch(/toast\.warning/);
  });
});
