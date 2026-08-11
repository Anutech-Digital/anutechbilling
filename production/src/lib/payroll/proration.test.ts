import { describe, it, expect } from "vitest";
import { daysElapsedInPeriod, prorateSalary } from "./proration";

describe("daysElapsedInPeriod", () => {
  it("current month → day-of-month so far, not complete", () => {
    expect(daysElapsedInPeriod("2026-08", "2026-08-07")).toEqual({ elapsed: 7, daysInMonth: 31, complete: false });
  });
  it("past month → full month, complete", () => {
    expect(daysElapsedInPeriod("2026-07", "2026-08-07")).toEqual({ elapsed: 31, daysInMonth: 31, complete: true });
  });
  it("future month → zero days, not complete", () => {
    expect(daysElapsedInPeriod("2026-09", "2026-08-07")).toEqual({ elapsed: 0, daysInMonth: 30, complete: false });
  });
  it("last day of current month → complete", () => {
    expect(daysElapsedInPeriod("2026-08", "2026-08-31")).toEqual({ elapsed: 31, daysInMonth: 31, complete: true });
  });
  it("February leap-ish length handled via Date", () => {
    expect(daysElapsedInPeriod("2026-02", "2026-02-15")).toEqual({ elapsed: 15, daysInMonth: 28, complete: false });
  });
});

describe("prorateSalary", () => {
  it("prorates to elapsed days", () => {
    expect(prorateSalary(20000, 7, 31)).toBe(4516); // 20000*7/31 = 4516.1 → 4516
  });
  it("full month = full salary", () => {
    expect(prorateSalary(20000, 31, 31)).toBe(20000);
  });
  it("zero days = zero", () => {
    expect(prorateSalary(20000, 0, 31)).toBe(0);
  });
  it("clamps days above the month length", () => {
    expect(prorateSalary(20000, 40, 31)).toBe(20000);
  });
  it("guards a zero-length month", () => {
    expect(prorateSalary(20000, 5, 0)).toBe(0);
  });
});
