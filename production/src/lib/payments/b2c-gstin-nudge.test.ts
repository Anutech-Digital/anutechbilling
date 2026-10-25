import { describe, it, expect } from "vitest";
import { b2cGstinNudge } from "./b2c-gstin-nudge";

/* R-1735 — owner examples on the card:
   1. Prospect GSTIN 07AAACR5055K1Z9 (the card said …Z5, which fails the checksum) → invoice carries it: no nudge.
   2. Prospect without GSTIN → Record payment says "No GSTIN — invoice will be B2C. Add GSTIN?" */
describe("b2cGstinNudge (R-1735)", () => {
  it("prospect quote whose lead has a valid GSTIN → no nudge", () => {
    expect(b2cGstinNudge({ quoteId: "Q-1", customerId: null, customer: null, lead: { gstin: "07AAACR5055K1Z9" } })).toBeNull();
  });

  it("prospect quote with no GSTIN → nudge pointing at the quote's edit page (where the GSTIN box is)", () => {
    const n = b2cGstinNudge({ quoteId: "Q-1", customerId: null, customer: null, lead: { gstin: null } });
    expect(n).toEqual({ text: "No GSTIN — invoice will be B2C.", label: "Add GSTIN", href: "/quotes/Q-1/edit" });
  });

  it("typed prospect with no lead at all → same nudge", () => {
    expect(b2cGstinNudge({ quoteId: "Q-2", customerId: null, customer: null, lead: null })?.href).toBe("/quotes/Q-2/edit");
  });

  it("a GSTIN that fails the checksum counts as none", () => {
    expect(b2cGstinNudge({ quoteId: "Q-1", customerId: null, customer: null, lead: { gstin: "07AAACR5055K1Z5" } })).not.toBeNull();
  });

  it("overseas prospect → no nudge (export, no GSTIN expected)", () => {
    expect(b2cGstinNudge({ quoteId: "Q-1", customerId: null, customer: null, lead: null, prospectCountry: "United States" })).toBeNull();
  });

  it("business customer without GSTIN → nudge to the customer's edit form", () => {
    const n = b2cGstinNudge({ quoteId: "Q-1", customerId: "c1", customer: { gstin: "", customer_type: "business" }, lead: null });
    expect(n?.href).toBe("/customers/c1/edit");
  });

  it("customer with a GSTIN, an individual, a consumer or an overseas buyer → no nudge", () => {
    const base = { quoteId: "Q-1", customerId: "c1", lead: null };
    expect(b2cGstinNudge({ ...base, customer: { gstin: "07AAACR5055K1Z9" } })).toBeNull();
    expect(b2cGstinNudge({ ...base, customer: { gstin: null, customer_type: "individual" } })).toBeNull();
    expect(b2cGstinNudge({ ...base, customer: { gstin: null, gst_treatment: "consumer" } })).toBeNull();
    expect(b2cGstinNudge({ ...base, customer: { gstin: null, country: "Singapore" } })).toBeNull();
  });

  it("a customer row we could not read (not loaded) says nothing rather than guessing", () => {
    expect(b2cGstinNudge({ quoteId: "Q-1", customerId: "c1", customer: null, lead: null })).toBeNull();
  });
});
