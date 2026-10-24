import { describe, it, expect } from "vitest";
import { prefillFromLead, findPlanProduct, billingChoiceFromCycle, subscriptionFromLeadHref } from "./lead-prefill";

describe("won deal → subscription form (R-073)", () => {
  it("maps the lead onto the form, trimmed; never copies a price", () => {
    const p = prefillFromLead({
      id: "L1", company: "  Acme Pvt Ltd ", customer_id: "C9", domain: "ACME.in", contact_name: "Asha",
      contact_email: " Asha@Acme.in ", contact_phone: "+91 98765 43210", plan: "Business Standard", seats: 12, billing_cycle: "yearly",
    });
    expect(p).toMatchObject({
      leadId: "L1", customerId: "C9", customerName: "Acme Pvt Ltd", domain: "acme.in", contactEmail: "asha@acme.in",
      plan: "Business Standard", seats: 12, billingChoice: "annual_yearly",
    });
    expect(p).not.toHaveProperty("price");
  });
  it("R-1712: the lead's GSTIN and state travel to the new customer (upper-cased, trimmed)", () => {
    const p = prefillFromLead({ id: "L4", company: "Acme", gstin: " 27aapfu0939f1zv ", state_code: "27" });
    expect(p).toMatchObject({ gstin: "27AAPFU0939F1ZV", stateCode: "27" });
    expect(prefillFromLead({ id: "L5", company: "X" })).toMatchObject({ gstin: "", stateCode: "" });
  });
  it("R-1712: the add-subscription form asks for a new customer's GSTIN and writes customers.gstin", () => {
    const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../components/features/subscriptions/add-subscription-dialog.tsx"), "utf8") as string;
    expect(src).toMatch(/id="newCustGstin"/);
    expect(src).toMatch(/gstin: newGstinValid/);
    const page = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../app/(app)/subscriptions/page.tsx"), "utf8") as string;
    expect(page).toMatch(/billing_cycle, gstin, state_code"\)/);
  });
  it("a missing or zero seat count stays empty rather than becoming 0 seats", () => {
    expect(prefillFromLead({ id: "L2", company: "X", seats: 0 }).seats).toBeNull();
    expect(prefillFromLead({ id: "L3", company: "X" }).seats).toBeNull();
  });
  it("monthly is flexible, everything else annual", () => {
    expect(billingChoiceFromCycle("monthly")).toBe("monthly_flex");
    expect(billingChoiceFromCycle("quarterly")).toBe("annual_yearly");
    expect(billingChoiceFromCycle(null)).toBe("annual_yearly");
  });
  it("finds the catalog product the plan text names", () => {
    const products = [{ name: "Google Workspace Business Starter" }, { name: "Google Workspace Business Standard" }, { name: "Microsoft 365 Business Standard" }];
    expect(findPlanProduct(products, "Google Workspace Business Standard")?.name).toBe("Google Workspace Business Standard");
    expect(findPlanProduct(products, "")).toBeUndefined();
    expect(subscriptionFromLeadHref("L 1")).toBe("/subscriptions?from_lead=L%201");
  });
});

describe("wiring (R-073)", () => {
  const read = (rel: string) => require("node:fs").readFileSync(require("node:path").join(__dirname, "../..", rel), "utf8") as string;
  it("a won deal offers the subscription (or, when one exists, opens subscriptions)", () => {
    const f = read("components/features/leads/lead-detail-footer.tsx");
    expect(f).toMatch(/lead\.stage === "won" && hasSub\.data === false/);
    expect(f).toMatch(/subscriptionFromLeadHref\(lead\.id\)/);
    expect(f).toMatch(/lead\.stage === "won" && hasSub\.data === true/);
  });
  it("the subscriptions page opens the form filled from ?from_lead", () => {
    const p = read("app/(app)/subscriptions/page.tsx");
    expect(p).toMatch(/get\("from_lead"\)/);
    expect(p).toMatch(/prefill=\{leadPrefill\}/);
    expect(read("components/features/subscriptions/add-subscription-dialog.tsx")).toMatch(/findPlanProduct\(products, prefill\.plan\)/);
  });
});
