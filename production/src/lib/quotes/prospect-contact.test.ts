import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prospectContactProblem, hasProspectContact, prospectLeadRow } from "./prospect-contact";

describe("R-469 (6): new prospect email / phone", () => {
  it("both empty is fine — the name alone still makes a quote", () => {
    expect(prospectContactProblem({ email: "", phone: "" })).toBeNull();
    expect(hasProspectContact({ email: " ", phone: "" })).toBe(false);
  });
  it("a bad email or a short phone is refused with a plain message", () => {
    expect(prospectContactProblem({ email: "amit@", phone: "" })).toMatch(/email/);
    expect(prospectContactProblem({ email: "", phone: "12345" })).toBe("A phone number needs at least 10 digits.");
  });
  it("good values pass", () => {
    expect(prospectContactProblem({ email: "amit@acme.in", phone: "+91 98765 43210" })).toBeNull();
  });
  it("the lead row carries the contact and moves to Quote Sent only when sent", () => {
    const row = prospectLeadRow({
      name: " Acme Pvt Ltd ", contact: { email: "amit@acme.in", phone: "9876543210" },
      stateCode: "27", stateName: "Maharashtra", country: "India", sent: true,
      plan: "Business Starter", seats: 5, value: 19116,
    });
    expect(row).toMatchObject({ company: "Acme Pvt Ltd", contact_email: "amit@acme.in", contact_phone: "9876543210", stage: "quote", state: "Maharashtra" });
    expect(prospectLeadRow({ name: "X", contact: { email: "", phone: "9876543210" }, stateCode: null, stateName: null, country: "", sent: false, plan: null, seats: 0, value: 0 }))
      .toMatchObject({ stage: "contact", contact_email: null, country: "India", seats: null, value: null });
  });
  /* R-1959: the lead is made BY saving a quote — a draft is contact, so it starts at Contacted
     (stageAfterQuoteSaved), and its seats come from leadSeatCount (a custom line counts). */
  it("R-1959: a draft-made lead starts at Contacted; a sent one at Quote Sent", () => {
    const base = { name: "Sharma Cloud Test", contact: { email: "", phone: "9876543210" }, stateCode: null, stateName: null, country: "India", plan: "GW Business Starter (1 year)", seats: 10, value: 0 };
    expect(prospectLeadRow({ ...base, sent: false })).toMatchObject({ stage: "contact", seats: 10 });
    expect(prospectLeadRow({ ...base, sent: true })).toMatchObject({ stage: "quote", seats: 10 });
  });
  /* R-1712: a business typed as a new prospect got a B2C invoice — no GSTIN was ever asked. */
  it("R-1712: a GSTIN must pass the checksum; a valid one alone is worth a lead, and the lead carries it", () => {
    expect(prospectContactProblem({ email: "", phone: "", gstin: "27AAPFU0939F1ZX" })).toMatch(/check digit/);
    expect(prospectContactProblem({ email: "", phone: "", gstin: "27AAPFU09" })).toMatch(/more characters/);
    expect(prospectContactProblem({ email: "", phone: "", gstin: "27aapfu0939f1zv" })).toBeNull();
    expect(hasProspectContact({ email: "", phone: "", gstin: "27AAPFU0939F1ZV" })).toBe(true);
    expect(hasProspectContact({ email: "", phone: "", gstin: "27AAPFU0939F1ZX" })).toBe(false);
    const row = prospectLeadRow({
      name: "Acme", contact: { email: "", phone: "", gstin: " 27aapfu0939f1zv " },
      stateCode: "27", stateName: "Maharashtra", country: "India", sent: false, plan: null, seats: 0, value: 0,
    });
    expect(row.gstin).toBe("27AAPFU0939F1ZV");
    expect(prospectLeadRow({ name: "X", contact: { email: "a@b.in", phone: "" }, stateCode: null, stateName: null, country: "", sent: false, plan: null, seats: 0, value: 0 }).gstin)
      .toBeNull();
  });
  it("R-1712: the builder's prospect form has the GSTIN box", () => {
    const src = readFileSync(join(__dirname, "../../components/features/quotes/quote-builder.tsx"), "utf8");
    expect(src).toMatch(/id="prospectGstin"/);
  });
  it("the builder shows the two fields and links the quote to the new lead", () => {
    const src = readFileSync(join(__dirname, "../../components/features/quotes/quote-builder.tsx"), "utf8");
    expect(src).toMatch(/id="prospectEmail"/);
    expect(src).toMatch(/id="prospectPhone"/);
    expect(src).toMatch(/prospectLeadRow\(/);
    expect(src).toMatch(/lead_id:\s+linkedLeadId \?\? prospectLeadId/);
  });
});
