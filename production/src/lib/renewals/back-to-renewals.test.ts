import { describe, expect, it } from "vitest";
import { quoteEditHrefFromRenewals, renewalsReturnTo } from "./back-to-renewals";

describe("R-2754 renewalsReturnTo", () => {
  it("keeps a Renewals URL with its tab", () => {
    expect(renewalsReturnTo("/renewals?bucket=next30")).toBe("/renewals?bucket=next30");
    expect(renewalsReturnTo("/renewals")).toBe("/renewals");
  });
  it("refuses anything that is not the Renewals page", () => {
    for (const bad of [null, "", "https://evil.com/renewals", "//evil.com/renewals", "/\evil.com", "/renewalsx", "/quotes", "renewals"]) {
      expect(renewalsReturnTo(bad)).toBeNull();
    }
  });
});

describe("R-2754 quoteEditHrefFromRenewals", () => {
  it("carries the Renewals URL to the editor", () => {
    expect(quoteEditHrefFromRenewals("Q-1/2", "/renewals?bucket=next30"))
      .toBe("/quotes/Q-1%2F2/edit?returnTo=%2Frenewals%3Fbucket%3Dnext30");
  });
  it("plain editor link when not on Renewals", () => {
    expect(quoteEditHrefFromRenewals("Q-1", "/subscriptions/x")).toBe("/quotes/Q-1/edit");
  });
});
