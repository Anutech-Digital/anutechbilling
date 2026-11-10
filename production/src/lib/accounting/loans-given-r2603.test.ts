import { describe, it, expect } from "vitest";
import { borrowerKey, distinctBorrowers, oldAdvanceGivenLines } from "./loans-given";

describe("R-2603 borrower names", () => {
  it("same person in another case / spacing has one key", () => {
    expect(borrowerKey("  julie   RAWAT ")).toBe(borrowerKey("Julie Rawat"));
    expect(borrowerKey("Julie Rawat")).not.toBe(borrowerKey("Julie Rawal"));
  });
  it("picker lists each person once, first spelling wins, sorted", () => {
    expect(distinctBorrowers(["Julie Rawat", "julie rawat", " Vinod  Hem Raj", "", null, "JULIE RAWAT"]))
      .toEqual(["Julie Rawat", "Vinod Hem Raj"]);
  });
});

describe("R-2603 old Balance Sheet loan lines", () => {
  const items = [
    { section: "asset", label: "Advance/loan given · Julie Rawat", amount: 100000 },
    { section: "asset", label: "Advance/loan given · julie rawat", amount: 50000 },
    { section: "asset", label: "Advance/loan given", amount: 2500 },
    { section: "asset", label: "Advance/loan returned · Julie Rawat", amount: -20000 },
    { section: "liability", label: "Loan received · Bank", amount: 90000 },
    { section: "asset", label: "Security deposit", amount: 7000 },
  ];
  it("counts 'Advance/loan given' lines, netted per person with their 'returned' lines", () => {
    expect(oldAdvanceGivenLines(items)).toEqual({ count: 3, total: 132500, borrowers: ["Julie Rawat"] });
  });
  it("a person who paid it all back is not counted", () => {
    expect(oldAdvanceGivenLines([
      { section: "asset", label: "Advance/loan given · Ravi", amount: 10000 },
      { section: "asset", label: "Advance/loan returned · RAVI", amount: -10000 },
    ])).toEqual({ count: 0, total: 0, borrowers: [] });
  });
  it("none → zero", () => {
    expect(oldAdvanceGivenLines([])).toEqual({ count: 0, total: 0, borrowers: [] });
  });
});
