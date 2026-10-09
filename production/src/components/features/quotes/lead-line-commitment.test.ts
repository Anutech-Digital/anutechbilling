import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { leadLinePrice } from "./lead-line-commitment";

describe("R-446: the lead's billing cycle sets the first quote line", () => {
  it("a yearly or blank lead keeps the annual line, unchanged", () => {
    for (const cycle of ["yearly", null, undefined, ""]) {
      expect(leadLinePrice({ cycle, annualRate: 3240, annualCost: 1320 }))
        .toEqual({ commitment: "annual_yearly", rate: 3240, cost: 1320, unit: "yr" });
    }
  });

  it("a monthly lead takes the catalogue's own monthly-flex tier (per seat per MONTH)", () => {
    expect(leadLinePrice({
      cycle: "monthly", annualRate: 3240, annualCost: 1320,
      prices: { annual: { msrp: 270, wholesale: 110 }, monthly: { msrp: 324, wholesale: 132 } },
    })).toEqual({ commitment: "monthly", rate: 324, cost: 132, unit: "mo" });
  });

  it("a monthly lead with no monthly tier converts the unit (÷12), never keeps a yearly rate", () => {
    const p = leadLinePrice({ cycle: "monthly", annualRate: 3240, annualCost: 1320, prices: { annual: { msrp: 270, wholesale: 110 } } });
    expect(p).toEqual({ commitment: "monthly", rate: 270, cost: 110, unit: "mo" });
  });

  it("an unknown cost stays unknown (0) on a monthly line", () => {
    expect(leadLinePrice({ cycle: "monthly", annualRate: 3240, annualCost: 0 }).cost).toBe(0);
  });

  it("the builder's lead prefill uses it (not a hardcoded annual_yearly)", () => {
    const src = readFileSync("src/components/features/quotes/quote-builder.tsx", "utf8");
    const prefill = src.slice(src.indexOf("prefilledRef.current = true;"), src.indexOf("// Pre-fill notes with friendly"));
    expect(prefill).toContain("leadLinePrice(");
    expect(prefill).not.toMatch(/commitment:\s*"annual_yearly"/);
  });
});
