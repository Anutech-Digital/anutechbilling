/** R-1104: run history rules (status from the gate's line, what is recorded, Retry). */
import { describe, it, expect } from "vitest";
import { canRetry, groupRuns, runStatus, shouldRecordRun, type JobRun } from "./run-history";

describe("runStatus — from the line the gate writes", () => {
  it.each([
    ["Ran: sent 3, failed 0", "ok"],
    ["Ran", "ok"],
    ["Failed (500)", "failed"],
    ["Failed: connect ECONNREFUSED", "failed"],
    ["Skipped — turned off", "skipped"],
    ["Practice run is not available for this job — nothing was done", "skipped"],
    ["Practice run: considered 4 — would send 2 messages to a@b.in; nothing was sent", "practice"],
  ])("%s → %s", (line, status) => {
    expect(runStatus(line)).toBe(status);
  });
});

describe("shouldRecordRun", () => {
  it("a scheduled pass of a job that is off is not recorded (every-minute jobs would bury the history)", () => {
    expect(shouldRecordRun("Skipped — turned off", "schedule")).toBe(false);
  });
  it("a person pressing Run now on a job that is off IS recorded", () => {
    expect(shouldRecordRun("Skipped — turned off", "manual")).toBe(true);
  });
  it("every real run is recorded", () => {
    expect(shouldRecordRun("Ran: sent 2", "schedule")).toBe(true);
    expect(shouldRecordRun("Failed (500)", "schedule")).toBe(true);
    expect(shouldRecordRun("Ran", "retry")).toBe(true);
  });
});

const run = (id: string, job: string, ranAt: string, status: JobRun["status"] = "ok"): JobRun =>
  ({ id, job, ranAt, status, trigger: "schedule", result: null, startedBy: null, retryOf: null });

describe("groupRuns", () => {
  it("groups by job, newest first, capped per job", () => {
    const g = groupRuns([
      run("a", "renewals", "2026-10-20T03:30:00Z"),
      run("b", "renewals", "2026-10-22T03:30:00Z"),
      run("c", "backup", "2026-10-21T18:30:00Z"),
      run("d", "renewals", "2026-10-21T03:30:00Z"),
    ], 2);
    expect(g.renewals.map((r) => r.id)).toEqual(["b", "d"]);
    expect(g.backup.map((r) => r.id)).toEqual(["c"]);
  });
});

describe("canRetry", () => {
  it("only the newest run, and only when it failed", () => {
    expect(canRetry({ id: "x", status: "failed" }, "x")).toBe(true);
    expect(canRetry({ id: "x", status: "failed" }, "y")).toBe(false);   // a later run happened
    expect(canRetry({ id: "x", status: "ok" }, "x")).toBe(false);
    expect(canRetry({ id: "x", status: "skipped" }, "x")).toBe(false);
  });
});
