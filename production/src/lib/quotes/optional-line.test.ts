// R-1755 (owner examples, 22 Oct 2026): a Workspace seat line can be optional (a second plan the
// customer may take), but only after a warning; an add-on / one-time line needs none.
import { describe, it, expect } from "vitest";
import { lineIsSubscription, optionalNeedsConfirm } from "./optional-line";

describe("optionalNeedsConfirm (R-1755)", () => {
  it("Google Workspace Starter × 10, Annual, catalogue Main → asks first", () => {
    expect(optionalNeedsConfirm({ commitment: "annual_yearly" }, "main")).toBe(true);
  });
  it("a second plan on Monthly flex → asks first", () => {
    expect(optionalNeedsConfirm({ commitment: "monthly" }, "main")).toBe(true);
  });
  it("Support add-on (renews yearly) → no question", () => {
    expect(optionalNeedsConfirm({ commitment: "annual_yearly" }, "addon")).toBe(false);
  });
  it("One-time line (custom 'Support Charges', migration) → no question", () => {
    expect(optionalNeedsConfirm({ one_time: true }, undefined)).toBe(false);
    expect(optionalNeedsConfirm({}, undefined)).toBe(false);
    expect(optionalNeedsConfirm({ commitment: "annual_yearly", one_time: true }, "main")).toBe(false);
  });
  it("custom recurring line (no catalogue kind) → asks (cannot tell it from seats)", () => {
    expect(optionalNeedsConfirm({ commitment: "annual_yearly" }, undefined)).toBe(true);
  });
});

describe("lineIsSubscription mirrors quote_line_is_subscription as the builder saves", () => {
  it("marker → no; commitment → yes; 'one_time' commitment → no; none → no", () => {
    expect(lineIsSubscription({ one_time: true })).toBe(false);
    expect(lineIsSubscription({ commitment: "annual_monthly" })).toBe(true);
    expect(lineIsSubscription({ commitment: "one_time" as never })).toBe(false);
    expect(lineIsSubscription({})).toBe(false);
  });
});
