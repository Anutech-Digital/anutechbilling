import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { leadStatePatch, stateFromLeadGstin, stateLabel } from "@/lib/leads/lead-state";

/* R-376 (a): the Add lead wizard had no State, but GST depends on it — the quote builder's
   Place of supply prefills from leads.state_code and record_payment copies it to the customer. */

const read = (...p: string[]) => readFileSync(join(process.cwd(), "src", ...p), "utf8");
const FORM = read("components", "features", "leads", "add-lead-form.tsx");
const BUILDER = read("components", "features", "quotes", "quote-builder.tsx");

describe("lead-state helpers", () => {
  it("a valid GSTIN gives its state; a partial or bad one gives nothing", () => {
    expect(stateFromLeadGstin("27AABCE1234D1Z9")).toBe("27");
    expect(stateFromLeadGstin("06AABCF1234A1ZI")).toBe("06");
    expect(stateFromLeadGstin("06AABCF")).toBeNull();
    expect(stateFromLeadGstin("06AABCF1234A1Z5")).toBeNull(); // checksum fails
  });

  it("a NEW lead always writes state_code + state name (null when blank)", () => {
    expect(leadStatePatch("06", null)).toEqual({ state_code: "06", state: "Haryana" });
    expect(leadStatePatch("", null)).toEqual({ state_code: null, state: null });
  });

  it("an EDIT writes only when the select moved — a slim row without state_code is not wiped", () => {
    expect(leadStatePatch("06", { state_code: "06" })).toEqual({});
    expect(leadStatePatch("", {})).toEqual({});
    expect(leadStatePatch("07", { state_code: "06" })).toEqual({ state_code: "07", state: "Delhi" });
    expect(leadStatePatch("", { state_code: "06" })).toEqual({ state_code: null, state: null });
  });

  it("Review shows 'Haryana (06)'", () => {
    expect(stateLabel("06")).toBe("Haryana (06)");
    expect(stateLabel("")).toBe("");
  });
});

describe("Add lead form wiring", () => {
  it("the State select sits on the Contact step and is validated with it", () => {
    expect(FORM).toMatch(/\["company", "contact_name", "contact_email", "contact_phone", "gstin", "state_code"\]/);
    const contactStep = FORM.slice(FORM.indexOf("<Step show={!useSteps || step === 1}>"), FORM.indexOf("<Step show={!useSteps || step === 2}>"));
    expect(contactStep).toMatch(/<FormField label="State" htmlFor="state_code">/);
    expect(contactStep).toMatch(/GST_STATE_OPTIONS\.map/);
  });

  it("the state is saved through leadStatePatch and shown on Review", () => {
    expect(FORM).toMatch(/\.\.\.leadStatePatch\(data\.state_code, isEditing \? editingLead : null\)/);
    expect(FORM).toMatch(/<Review label="State"/);
  });

  it("a typed GSTIN fills the state from its first two digits", () => {
    expect(FORM).toMatch(/const gstinStateCode = stateFromLeadGstin\(wGstin\)/);
    expect(FORM).toMatch(/setValue\("state_code", gstinStateCode/);
  });

  it("the quote builder prefills Place of supply from the lead (state, else its GSTIN)", () => {
    expect(BUILDER).toMatch(/const leadStateInit = leadFromQuery\?\.state_code \?\? ""/);
    expect(BUILDER).toMatch(/const leadGstinState = !leadStateInit \? \(stateCodeFromGstin\(leadGstinInit\) \?\? ""\) : ""/);
  });
});
