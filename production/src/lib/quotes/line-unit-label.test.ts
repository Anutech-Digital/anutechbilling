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

/* R-1673 (3): staging — the domain line printed "Per seat per year" on the PDF. */
describe("lineUnitLabel — domain line (R-1673)", () => {
  it("a domain registration is per domain, not per seat", () => {
    const d = { name: "Domain registration (.in)", commitment: "annual_yearly", qty: 1, domain: "acme.in" };
    expect(lineUnitLabel(d, false)).toBe("Per domain per year");
    expect(lineUnitLabel(d, true)).toBe("Per domain");
  });
  it("a multi-year registration says the term the rate covers", () => {
    expect(lineUnitLabel({ name: "Domain registration (.com)", commitment: "annual_yearly", qty: 1, years: 3 }, false))
      .toBe("Per domain for 3 years");
  });
});
