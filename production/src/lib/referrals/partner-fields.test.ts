import { describe, it, expect } from "vitest";
import { panProblem, normalisePan, commissionPercentProblem } from "./partner-fields";

describe("panProblem (R-472)", () => {
  it("refuses 'abc' and other wrong shapes", () => {
    expect(panProblem("abc")).toMatch(/5 letters, 4 digits, 1 letter/);
    expect(panProblem("ABCDE12345")).not.toBeNull();
    expect(panProblem("1BCDE1234F")).not.toBeNull();
    expect(panProblem("ABCDE1234FG")).not.toBeNull();
  });
  it("accepts a real PAN in any case and blank", () => {
    expect(panProblem("ABCDE1234F")).toBeNull();
    expect(panProblem("abcde1234f")).toBeNull();
    expect(panProblem(" ABCDE 1234F ")).toBeNull();
    expect(panProblem("")).toBeNull();
    expect(normalisePan(" abcde 1234f")).toBe("ABCDE1234F");
  });
});

describe("commissionPercentProblem", () => {
  it("empty, zero and over 100 are refused with a reason", () => {
    expect(commissionPercentProblem("")).toMatch(/e\.g\. 10/);
    expect(commissionPercentProblem("0")).not.toBeNull();
    expect(commissionPercentProblem("10150")).not.toBeNull();
    expect(commissionPercentProblem("150")).not.toBeNull();
  });
  it("1 to 100 is fine", () => {
    expect(commissionPercentProblem("10")).toBeNull();
    expect(commissionPercentProblem("2.5")).toBeNull();
    expect(commissionPercentProblem("100")).toBeNull();
  });
});
