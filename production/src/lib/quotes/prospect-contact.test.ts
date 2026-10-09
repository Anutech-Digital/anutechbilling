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
      .toMatchObject({ stage: "new", contact_email: null, country: "India", seats: null, value: null });
  });
  it("the builder shows the two fields and links the quote to the new lead", () => {
    const src = readFileSync(join(__dirname, "../../components/features/quotes/quote-builder.tsx"), "utf8");
    expect(src).toMatch(/id="prospectEmail"/);
    expect(src).toMatch(/id="prospectPhone"/);
    expect(src).toMatch(/prospectLeadRow\(/);
    expect(src).toMatch(/lead_id:\s+linkedLeadId \?\? prospectLeadId/);
  });
});
