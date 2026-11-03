/**
 * R-2428 — owner's case (staging Anutech, 3 Nov): Keshav Malik joined in April, left in his
 * first month (full & final ₹19,056 paid 16 Apr), yet salary lines kept making ₹24,358 records
 * for Jun–Sep and a March record from another company's bank line.
 */
import { describe, it, expect } from "vitest";
import { salaryLineRisks, isFullAndFinalText, parseSalaryNarration } from "./salary-lines";

const keshav = { id: "e-k", name: "Keshav Malik", joining_date: "2026-04-01", exit_date: null, is_active: true };

describe("R-2428 salaryLineRisks — before a NEW salary record is made from a bank line", () => {
  it("after the last working day → blocked, says when they left", () => {
    const r = salaryLineRisks({
      employee: { ...keshav, exit_date: "2026-04-16" }, period: "2026-06",
      lineKey: null, knownKeys: [], salaries: [],
    });
    expect(r.block).toMatch(/Keshav Malik left on 16 Apr 2026 — no salary after Apr 2026/);
  });

  it("the exit month itself is not blocked", () => {
    const r = salaryLineRisks({
      employee: { ...keshav, exit_date: "2026-04-16" }, period: "2026-04",
      lineKey: null, knownKeys: [], salaries: [],
    });
    expect(r.block).toBeNull();
  });

  it("a month after a full & final was paid (exit not started) → warned", () => {
    const r = salaryLineRisks({
      employee: keshav, period: "2026-06", lineKey: null, knownKeys: [],
      salaries: [{ employee_id: "e-k", period: "2026-04", notes: "Created from bank line: 50100508749370-TPT-FULL N FINAL SALARY-KESHAV MALIK" }],
    });
    expect(r.block).toBeNull();
    expect(r.warnings.join(" ")).toMatch(/full & final was paid for Apr 2026/);
  });

  it("a month before joining → warned (may be another company's line)", () => {
    const r = salaryLineRisks({ employee: keshav, period: "2026-03", lineKey: null, knownKeys: [], salaries: [] });
    expect(r.warnings.join(" ")).toMatch(/joined on 1 Apr 2026.*before they joined/);
  });

  it("a different payee account than the employee's other salaries → warned", () => {
    const r = salaryLineRisks({
      employee: keshav, period: "2026-04", lineKey: "acct:111122223333", knownKeys: ["acct:50100508749370"], salaries: [],
    });
    expect(r.warnings.join(" ")).toMatch(/different account/);
  });

  it("same account, in the joining month, nothing else → no warning", () => {
    const r = salaryLineRisks({
      employee: keshav, period: "2026-04", lineKey: "acct:50100508749370", knownKeys: ["acct:50100508749370"], salaries: [],
    });
    expect(r).toEqual({ block: null, warnings: [] });
  });

  it("inactive with no exit date → warned", () => {
    const r = salaryLineRisks({ employee: { ...keshav, is_active: false }, period: "2026-05", lineKey: null, knownKeys: [], salaries: [] });
    expect(r.warnings.join(" ")).toMatch(/inactive/);
  });
});

describe("R-2428 isFullAndFinalText", () => {
  it.each([
    ["50100508749370-TPT-FULL N FINAL SALARY-KESHAV MALIK", true],
    ["F&F SETTLEMENT RAVI", true],
    ["FNF SALARY ASHA", true],
    ["Full and final settlement", true],
    ["SALARY APR 2026-PAWAN", false],
  ])("%s → %s", (text, want) => {
    expect(isFullAndFinalText(text)).toBe(want);
  });

  it("parseSalaryNarration uses the same rule", () => {
    expect(parseSalaryNarration("50100508749370-TPT-FULL N FINAL SALARY-KESHAV MALIK", "2026-04-16")?.fullAndFinal).toBe(true);
  });
});
