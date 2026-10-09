import { describe, it, expect } from "vitest";
import { lineUnitLabel } from "./line-unit-label";

describe("lineUnitLabel (R-469 (4))", () => {
  it("a licence line is per seat", () => {
    expect(lineUnitLabel({ name: "Google Workspace Business Standard", commitment: "annual_yearly", qty: 10 }, false)).toBe("Per seat per year");
    expect(lineUnitLabel({ name: "Google Workspace Business Standard", commitment: "annual_yearly", qty: 10 }, true)).toBe("Per seat");
  });

  it("a support plan is a flat fee, not per seat", () => {
    expect(lineUnitLabel({ name: "Standard Support (Yearly)", commitment: "annual_yearly", qty: 1 }, false)).toBe("Flat fee per year");
  });

  it("a service with no term is one-time", () => {
    expect(lineUnitLabel({ name: "Data migration", commitment: null, qty: 1 }, false)).toBe("One-time");
  });
});
