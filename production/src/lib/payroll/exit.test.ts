import { describe, it, expect } from "vitest";
import { employmentStatus, onPayrollFor, exitPayDays, noticeShortfall, defaultLastDay, EXIT_REASONS } from "./exit";

/* R-1896 — owner's example: Ravi resigns 1 Oct, last working day 15 Oct 2026, ₹1,05,000 gross. */
const ravi = { is_active: true, joining_date: "2020-04-01", exit_date: "2026-10-15" };
const staying = { is_active: true, joining_date: "2020-04-01", exit_date: null };

describe("employmentStatus", () => {
  it("no exit → active; unticked without exit → inactive", () => {
    expect(employmentStatus(staying, "2026-10-25")).toBe("active");
    expect(employmentStatus({ ...staying, is_active: false }, "2026-10-25")).toBe("inactive");
  });
  it("before and on the last day → exiting; the day after → exited", () => {
    expect(employmentStatus(ravi, "2026-10-01")).toBe("exiting");
    expect(employmentStatus(ravi, "2026-10-15")).toBe("exiting");
    expect(employmentStatus(ravi, "2026-10-16")).toBe("exited");
  });
  it("exited even if is_active was never flipped (read-time, no cron)", () => {
    expect(employmentStatus({ ...ravi, is_active: true }, "2026-11-02")).toBe("exited");
  });
});

describe("onPayrollFor — who appears in a month's payroll", () => {
  it("leaver stays in the exit month even after the last day passed", () => {
    expect(onPayrollFor(ravi, "2026-10")).toBe(true);
  });
  it("leaver is out of every month after the exit month", () => {
    expect(onPayrollFor(ravi, "2026-11")).toBe(false);
    expect(onPayrollFor(ravi, "2026-12")).toBe(false);
  });
  it("exit month stays even when the DB already made the employee inactive", () => {
    expect(onPayrollFor({ ...ravi, is_active: false }, "2026-10")).toBe(true);
  });
  it("plain inactive (no exit) is out; active is in", () => {
    expect(onPayrollFor({ ...staying, is_active: false }, "2026-10")).toBe(false);
    expect(onPayrollFor(staying, "2026-10")).toBe(true);
  });
  it("not yet joined in that month → out", () => {
    expect(onPayrollFor({ ...staying, joining_date: "2026-11-05" }, "2026-10")).toBe(false);
  });
});

describe("exitPayDays — pro-rata to the last working day", () => {
  it("exit month → days up to the last day", () => {
    expect(exitPayDays(ravi, "2026-10")).toEqual({ days: 15, daysInMonth: 31, lastDay: "2026-10-15" });
  });
  it("other months → null (normal pay)", () => {
    expect(exitPayDays(ravi, "2026-09")).toBeNull();
    expect(exitPayDays(staying, "2026-10")).toBeNull();
  });
});

describe("notice", () => {
  it("owner example: 30 days notice, resigned 1 Oct, last day 20 Oct → served 20, short 10", () => {
    expect(noticeShortfall({ resignationDate: "2026-10-01", lastDay: "2026-10-20", noticeDays: 30 })).toEqual({ served: 20, short: 10 });
  });
  it("full notice → short 0", () => {
    expect(noticeShortfall({ resignationDate: "2026-10-01", lastDay: "2026-10-30", noticeDays: 30 })).toEqual({ served: 30, short: 0 });
  });
  it("default last day = resignation + notice − 1", () => {
    expect(defaultLastDay("2026-10-01", 30)).toBe("2026-10-30");
  });
});

it("reasons are the DB's list, in English", () => {
  expect(EXIT_REASONS.map((r) => r.value)).toEqual(["resigned", "terminated", "retired", "absconding", "death", "contract_ended", "other"]);
});
