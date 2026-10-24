import { describe, it, expect } from "vitest";
import { SEZ_WITH_PAYMENT_ENDORSEMENT, SEZ_WITHOUT_PAYMENT_ENDORSEMENT, sezEndorsement } from "./sez-endorsement";

describe("R-1742 SEZ endorsement on the invoice (CGST Rule 46)", () => {
  it("is the statutory wording", () => {
    expect(SEZ_WITH_PAYMENT_ENDORSEMENT).toBe("SUPPLY MEANT FOR SEZ UNIT OR SEZ DEVELOPER FOR AUTHORISED OPERATIONS ON PAYMENT OF INTEGRATED TAX");
    expect(SEZ_WITHOUT_PAYMENT_ENDORSEMENT).toBe("SUPPLY MEANT FOR SEZ UNIT OR SEZ DEVELOPER FOR AUTHORISED OPERATIONS UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX");
  });

  it("owner's example: SEZ (with payment), ₹38,232 with IGST ₹5,832 → the with-payment line, no LUT", () => {
    expect(sezEndorsement({ treatment: "sez_with_payment", tax: 5832, lutNumber: "AD0710250000001" }))
      .toEqual({ text: SEZ_WITH_PAYMENT_ENDORSEMENT, lutArn: null });
  });

  it("SEZ with no tax charged → the without-payment line with the LUT ARN (never an invented one)", () => {
    expect(sezEndorsement({ treatment: "sez_without_payment", tax: 0, lutNumber: " AD0710250000001 " }))
      .toEqual({ text: SEZ_WITHOUT_PAYMENT_ENDORSEMENT, lutArn: "AD0710250000001" });
    expect(sezEndorsement({ treatment: "sez_without_payment", tax: 0, lutNumber: "" }))
      .toEqual({ text: SEZ_WITHOUT_PAYMENT_ENDORSEMENT, lutArn: null });
  });

  it("SEZ without payment but IGST charged (LUT rule pending) → says WITH payment: the words follow the tax on the invoice", () => {
    expect(sezEndorsement({ treatment: "sez_without_payment", tax: 5832, lutNumber: "X" })?.text).toBe(SEZ_WITH_PAYMENT_ENDORSEMENT);
  });

  it("nothing for every other treatment, or an invoice issued before R-1736", () => {
    for (const t of ["registered_regular", "deemed_export", "overseas", "consumer", null, undefined]) {
      expect(sezEndorsement({ treatment: t, tax: 5832, lutNumber: "X" })).toBeNull();
    }
  });
});
