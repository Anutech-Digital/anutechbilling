/* R-1529 — the GST registration setting: defaults, validation, patch, missing-column read. */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_COMPOSITION_RATE, effectiveGstRegistration, gstRegistrationFromRow, gstRegistrationPatch,
  gstRegistrationProblem, issuesBillOfSupply,
} from "./gst-registration";

const GSTIN = "07ABDCA0298H1ZP";

describe("effectiveGstRegistration", () => {
  it("Registered is the default when a GSTIN is on file", () => {
    expect(effectiveGstRegistration(null, GSTIN)).toBe("registered");
  });
  it("no GSTIN and nothing chosen → not chosen (the card asks)", () => {
    expect(effectiveGstRegistration(null, null)).toBeNull();
    expect(effectiveGstRegistration(null, "  ")).toBeNull();
  });
  it("a saved choice wins", () => {
    expect(effectiveGstRegistration("composition", GSTIN)).toBe("composition");
  });
});

describe("issuesBillOfSupply", () => {
  it("unregistered and composition issue Bills of Supply; registered and not-chosen do not", () => {
    expect(issuesBillOfSupply("unregistered")).toBe(true);
    expect(issuesBillOfSupply("composition")).toBe(true);
    expect(issuesBillOfSupply("registered")).toBe(false);
    expect(issuesBillOfSupply(null)).toBe(false);
  });
});

describe("gstRegistrationProblem — same rules as the database", () => {
  it("not registered with a GSTIN is refused, with the fix", () => {
    expect(gstRegistrationProblem({ status: "unregistered", gstin: GSTIN, compositionRate: 6, registeredFrom: null }))
      .toMatch(/Clear the GSTIN/);
  });
  it("composition without a GSTIN is refused", () => {
    expect(gstRegistrationProblem({ status: "composition", gstin: null, compositionRate: 6, registeredFrom: null }))
      .toMatch(/Add it/);
  });
  it.each([0, -1, 10.5, Number.NaN, "abc"])("composition rate %s is refused", (rate) => {
    expect(gstRegistrationProblem({ status: "composition", gstin: GSTIN, compositionRate: rate, registeredFrom: null }))
      .toMatch(/at most 10%/);
  });
  it("valid inputs pass", () => {
    expect(gstRegistrationProblem({ status: "unregistered", gstin: "", compositionRate: 6, registeredFrom: null })).toBeNull();
    expect(gstRegistrationProblem({ status: "composition", gstin: GSTIN, compositionRate: "1", registeredFrom: "2026-04-01" })).toBeNull();
    expect(gstRegistrationProblem({ status: "registered", gstin: GSTIN, compositionRate: null, registeredFrom: "2026-11-01" })).toBeNull();
  });
  it("a malformed date is refused", () => {
    expect(gstRegistrationProblem({ status: "registered", gstin: GSTIN, compositionRate: null, registeredFrom: "01/11/2026" }))
      .toMatch(/date/);
  });
});

describe("gstRegistrationPatch", () => {
  it("composition writes its rate (rounded to 2 places)", () => {
    expect(gstRegistrationPatch({ status: "composition", gstin: GSTIN, compositionRate: "6.257", registeredFrom: "2026-04-01" }))
      .toEqual({ gst_registration: "composition", gst_composition_rate: 6.26, gst_registered_from: "2026-04-01" });
  });
  it("not registered clears the effective date and leaves the rate alone", () => {
    expect(gstRegistrationPatch({ status: "unregistered", gstin: null, compositionRate: 3, registeredFrom: "2026-04-01" }))
      .toEqual({ gst_registration: "unregistered", gst_registered_from: null });
  });
});

describe("gstRegistrationFromRow", () => {
  it("before the migration: not chosen, columnMissing", () => {
    const s = gstRegistrationFromRow(null, { code: "42703", message: 'column tenants.gst_registration does not exist' });
    expect(s).toEqual({ saved: null, compositionRate: DEFAULT_COMPOSITION_RATE, registeredFrom: null, columnMissing: true });
  });
  it("any other error throws (never read as 'registered')", () => {
    expect(() => gstRegistrationFromRow(null, { code: "500", message: "boom" })).toThrow(/boom/);
  });
  it("reads the row", () => {
    expect(gstRegistrationFromRow({ gst_registration: "composition", gst_composition_rate: "5.00", gst_registered_from: "2026-04-01" }, null))
      .toEqual({ saved: "composition", compositionRate: 5, registeredFrom: "2026-04-01", columnMissing: false });
  });
});
