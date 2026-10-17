import { describe, it, expect } from "vitest";
import { COMPANY_STATE_FIX, SETUP_HREF, companyStateFixFor, isCompanyStateMissingError } from "./setup-links";

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

/* R-1428 (Pawan, staging): "Send via WhatsApp / email" on a quote stopped at "Company state not
   set" with no way forward. The block stays (GST needs the state); the message now says what
   happened, why, and the next step — for the owner a button to the state field itself, for
   anyone else "ask the owner" (Settings → Company is view-only for them). */
describe("companyStateFixFor", () => {
  it("gives the owner a button that opens the Registered state field", () => {
    const fix = companyStateFixFor("owner");
    expect(fix.title).toBe(COMPANY_STATE_FIX.message);
    expect(fix.description).toMatch(/place of supply/i);
    expect(fix.description).toMatch(/CGST \+ SGST or IGST/);
    expect(fix.action.label).toBe("Set company state");
    expect(fix.action.href).toBe(SETUP_HREF.companyState);
    expect(SETUP_HREF.companyState).toBe("/settings?tab=company#settings-registered-state");
  });

  it("tells a non-owner to ask the owner, and links only to the view-only page", () => {
    for (const role of ["manager", "sales", "accounts", null, undefined]) {
      const fix = companyStateFixFor(role);
      expect(fix.title).toBe(COMPANY_STATE_FIX.message);
      expect(fix.description).toMatch(/ask the owner/i);
      expect(fix.action.label).not.toMatch(/^Set/);
      expect(fix.action.href).toBe(SETUP_HREF.company);
    }
  });
});
