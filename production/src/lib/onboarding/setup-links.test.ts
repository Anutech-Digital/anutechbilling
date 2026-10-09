import { describe, it, expect } from "vitest";
import { COMPANY_STATE_FIX, SETUP_HREF, isCompanyStateMissingError } from "./setup-links";

/* R-431 (board R-406): the company-state refusal from generate_invoice gets a one-click fix. */
describe("COMPANY_STATE_FIX", () => {
  it("opens the S31 company setup spot", () => {
    expect(COMPANY_STATE_FIX.href).toBe(SETUP_HREF.company);
  });

  it("recognises generate_invoice's company-state refusal", () => {
    expect(isCompanyStateMissingError({
      message: "Cannot issue this invoice: your own company has no state on record, so GST cannot decide between CGST+SGST and IGST. Set it in Settings → Company, then issue the invoice.",
    })).toBe(true);
  });

  it("does not match the customer-state refusal or other errors", () => {
    expect(isCompanyStateMissingError({ message: "Cannot issue this invoice: Acme has no state on record, so GST cannot decide" })).toBe(false);
    expect(isCompanyStateMissingError(new Error("Network problem"))).toBe(false);
    expect(isCompanyStateMissingError(null)).toBe(false);
  });
});
