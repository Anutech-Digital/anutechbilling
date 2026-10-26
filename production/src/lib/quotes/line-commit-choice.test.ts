import { describe, it, expect } from "vitest";
import { commitChoiceOf, commitmentForChoice, COMMIT_CHOICES, suggestCommitChoice, looksLikeSubscription } from "./line-commit-choice";

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

/* R-1963 — a licence typed as a Custom item was saved silently as one-time (no subscription,
   no renewal). The Custom item form now suggests a term from the name; the user still picks. */

describe("R-1963: term suggested from a custom line's name", () => {
  it("a yearly licence name suggests Annual", () => {
    for (const n of [
      "Google Workspace Business Starter (1 year)",
      "GW Business Starter (1 year)",
      "Microsoft 365 Business Basic",
      "Zoho Mail Lite - annual",
      "Antivirus licence per user",
      "Email seats yearly",
    ]) expect(suggestCommitChoice(n), n).toBe("annual");
  });
  it("a per-month name suggests Monthly flex", () => {
    for (const n of ["Backup 50 GB /month", "Helpdesk per month", "Hosting monthly plan", "Cloud VM (1 month)"])
      expect(suggestCommitChoice(n), n).toBe("monthly");
  });
  it("a plain service stays One-time", () => {
    for (const n of ["Data migration", "Custom training package", "Setup charges", "DNS configuration", ""])
      expect(suggestCommitChoice(n), n).toBe("one_time");
    expect(looksLikeSubscription("Data migration")).toBe(false);
    expect(looksLikeSubscription("GW Business Starter (1 year)")).toBe(true);
  });
  it("a one-time-worded name is never pushed to a subscription", () => {
    expect(suggestCommitChoice("Email migration (one-time)")).toBe("one_time");
    expect(suggestCommitChoice("One time setup for Workspace")).toBe("one_time");
  });
});
