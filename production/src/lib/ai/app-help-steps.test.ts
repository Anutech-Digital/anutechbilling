/**
 * R-831: bug-draft steps must carry ONE number. The model writes "1. Open …" and the panel's
 * <ol> and bugReportText() number again — Abhishek saw "1 1." on screen and "1. 1. Open
 * /subscriptions" in the filed report.
 */
import { describe, it, expect } from "vitest";
import { stripStepNumber, cleanSteps, bugReportText, parseHelpAnswer, type BugDraft } from "./app-help";
import { draftToText } from "@/components/shared/help-report-tab";

describe("stripStepNumber", () => {
  it.each([
    ["1. Open /subscriptions", "Open /subscriptions"],
    ["2) Click 'New'", "Click 'New'"],
    ["3 - Save", "Save"],
    ["4- Save", "Save"],
    ["5: Save", "Save"],
    ["10. Press Send", "Press Send"],
    ["12) Press Send", "Press Send"],
    ["  7.   Open Settings  ", "Open Settings"],
    ["1. 1. Open /subscriptions", "Open /subscriptions"],
    ["(3) Open it", "Open it"],
  ])("%j → %j", (raw, want) => {
    expect(stripStepNumber(raw)).toBe(want);
  });

  it("leaves steps without a number alone", () => {
    expect(stripStepNumber("Open /subscriptions")).toBe("Open /subscriptions");
    expect(stripStepNumber("Click 'New Quote'")).toBe("Click 'New Quote'");
  });

  it("does not eat numbers that are part of the step", () => {
    expect(stripStepNumber("1.5 GB storage shows 0")).toBe("1.5 GB storage shows 0");
    expect(stripStepNumber("18% GST is added twice")).toBe("18% GST is added twice");
    expect(stripStepNumber("2024 invoices are missing")).toBe("2024 invoices are missing");
  });

  it("cleanSteps drops steps that were only a number", () => {
    expect(cleanSteps(["1. Open", "2.", "  ", "3) Save"])).toEqual(["Open", "Save"]);
  });
});

const draft: BugDraft = {
  title: "Renew button does nothing",
  type: "bug",
  severity: "high",
  actual: "Nothing happens",
  expected: "Renewal quote opens",
  steps: ["1. Open /subscriptions", "2. Click 'Renew'", "Wait", "10. Look at the toast"],
  chatSummary: "",
};

describe("filed report text has one number per step", () => {
  it("bugReportText", () => {
    const t = bugReportText(draft, { pagePath: "/subscriptions", reporterName: "Abhishek" });
    expect(t).toContain("1. Open /subscriptions\n2. Click 'Renew'\n3. Wait\n4. Look at the toast");
    expect(t).not.toMatch(/\d\.\s+\d+[.)]/);
  });

  it("draftToText (Report a problem → Write it up with AI)", () => {
    const t = draftToText(draft);
    expect(t).toContain("1. Open /subscriptions\n2. Click 'Renew'\n3. Wait\n4. Look at the toast");
    expect(t).not.toContain("1. 1.");
  });

  it("parseHelpAnswer stores the steps without the model's numbers", () => {
    const a = parseHelpAnswer({ reply: "ok", bugDraft: { title: "T", actual: "A", steps: ["1. Open", "2) Click", "3."] } });
    expect(a?.bugDraft?.steps).toEqual(["Open", "Click"]);
  });
});
