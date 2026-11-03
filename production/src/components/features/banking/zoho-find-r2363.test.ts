/* R-2363 — Find in Zoho → "Create customer" starts the Add-customer form with WHERE Zoho's customer
   is. Staging, 2 Nov 2026: Ranz International LLC (Dubai, Zoho "overseas") was created as India /
   unregistered because only the name + GSTIN went to the form. Made-up names below. */
import { describe, expect, it } from "vitest";
import { newCustomerSeedFromZoho } from "./zoho-find-panel";

describe("R-2363 newCustomerSeedFromZoho", () => {
  it("overseas → country, Overseas, its state; no GSTIN even if Zoho holds one", () => {
    expect(newCustomerSeedFromZoho({
      zohoId: "z1", name: "Ranz International LLC", gstin: "27AAPFU0939F1ZV",
      country: "United Arab Emirates", gstTreatment: "overseas", state: "Dubai",
    })).toEqual({ name: "Ranz International LLC", gstin: null, country: "United Arab Emirates", gst_treatment: "overseas", state: "Dubai" });
  });
  it("Indian → India, Zoho's treatment and state; nothing Zoho did not give", () => {
    expect(newCustomerSeedFromZoho({
      zohoId: "z2", name: "Sharma Traders", gstin: "27AAPFU0939F1ZV", country: "India", gstTreatment: "registered_regular", state: "Maharashtra",
    })).toEqual({ name: "Sharma Traders", gstin: "27AAPFU0939F1ZV", country: "India", gst_treatment: "registered_regular", state: "Maharashtra" });
    expect(newCustomerSeedFromZoho({ zohoId: "z3", name: "Old Match", gstin: null })).toEqual({ name: "Old Match", gstin: null });
  });
});
