import { describe, expect, it } from "vitest";
import { isMixedTerm, lineTerm, ONE_TERM_MESSAGE } from "./single-term";

describe("R-381 single billing term per quote", () => {
  it("treats a missing commitment as annual", () => {
    expect(lineTerm(undefined)).toBe("annual");
    expect(lineTerm(null)).toBe("annual");
    expect(lineTerm("annual_monthly")).toBe("annual");
    expect(lineTerm("monthly")).toBe("monthly");
  });

  it("flags a monthly flex line next to an annual one", () => {
    expect(isMixedTerm([{ commitment: "monthly" }, { commitment: "annual_yearly" }])).toBe(true);
    expect(isMixedTerm([{ commitment: "monthly" }, {}])).toBe(true);
    expect(isMixedTerm([{ commitment: "annual_quarterly" }, { commitment: "monthly" }])).toBe(true);
  });

  it("allows an all-monthly or all-annual quote", () => {
    expect(isMixedTerm([])).toBe(false);
    expect(isMixedTerm([{ commitment: "monthly" }, { commitment: "monthly" }])).toBe(false);
    expect(isMixedTerm([{ commitment: "annual_yearly" }, { commitment: "annual_monthly" }, {}])).toBe(false);
  });

  it("says what to do", () => {
    expect(ONE_TERM_MESSAGE).toMatch(/separate quote/);
  });
});
