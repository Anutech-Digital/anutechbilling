import { describe, it, expect } from "vitest";
import { matchesAllTerms } from "./keywords";

describe("matchesAllTerms — the palette's filter (2 Oct 2026)", () => {
  it("finds a row by a word in it, any case", () => {
    expect(matchesAllTerms(["Thetaco Dentals", "info@thetacodentals.com"], "thetaco")).toBe(true);
  });
  it("does NOT fuzzy-match letters scattered across the row", () => {
    expect(matchesAllTerms(["Test User 3", "Etaco IT Solutions", "sales@etait.test", "+919876500001"], "Thetaco")).toBe(false);
  });
  it("every word must match, in any field", () => {
    expect(matchesAllTerms(["Thetaco Dentals", "Dr. Test User 2"], "user dentals")).toBe(true);
    expect(matchesAllTerms(["Thetaco Dentals", "Dr. Test User 2"], "user democo")).toBe(false);
  });
  it("a phone number matches however it is written", () => {
    expect(matchesAllTerms(["+919494947304"], "94949 47304")).toBe(true);
    expect(matchesAllTerms(["+919494947304"], "9494947304")).toBe(true);
    expect(matchesAllTerms(["+91 94949 47304"], "9494947304")).toBe(true);
  });
  it("an empty query matches everything", () => {
    expect(matchesAllTerms(["x"], "  ")).toBe(true);
  });
});
