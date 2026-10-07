import { describe, it, expect } from "vitest";
import { commitChoiceOf, commitmentForChoice, COMMIT_CHOICES } from "./line-commit-choice";

describe("R-389 (F4): line commitment select", () => {
  it("a line saved without a commitment shows One-time, not Annual", () => {
    expect(commitChoiceOf(null)).toBe("one_time");
    expect(commitChoiceOf(undefined)).toBe("one_time");
  });
  it("monthly and every annual_* show as before", () => {
    expect(commitChoiceOf("monthly")).toBe("monthly");
    expect(commitChoiceOf("annual_yearly")).toBe("annual");
    expect(commitChoiceOf("annual_quarterly")).toBe("annual");
  });
  it("picking an option saves the right commitment (One-time = none)", () => {
    expect(commitmentForChoice("one_time")).toBeNull();
    expect(commitmentForChoice("monthly")).toBe("monthly");
    expect(commitmentForChoice("annual")).toBe("annual_yearly");
  });
  it("round-trips every option", () => {
    for (const c of COMMIT_CHOICES) expect(commitChoiceOf(commitmentForChoice(c.value))).toBe(c.value);
  });
});
