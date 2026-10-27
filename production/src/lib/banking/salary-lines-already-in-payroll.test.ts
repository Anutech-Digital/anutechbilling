/**
 * R-1831 — "Salary lines" must never record a month payroll already has (e.g. Manoj's May
 * salary when May payroll exists). alreadyInPayroll() is the guard; the dialog skips such a
 * line and says "Already in payroll".
 */
import { describe, it, expect } from "vitest";
import { alreadyInPayroll, matchEmployee, parseSalaryNarration, type PayrollRecordLite } from "./salary-lines";

const employees = [
  { id: "manoj", name: "Manoj" },
  { id: "ravi", name: "Ravi Kumar" },
];
const rec = (o: Partial<PayrollRecordLite>): PayrollRecordLite =>
  ({ employee_id: "manoj", period: "2026-05", net: 25000, paid_amount: 0, paid_status: "unpaid", ...o });

describe("R-1831 — alreadyInPayroll", () => {
  it("the risk itself: statement 'MANOJ KUMAR S' is not recognised as Manoj → offered as a NEW employee → skipped, May is already in payroll", () => {
    const parsed = parseSalaryNarration("50100784857169-TPT-SALARY MAY 2026-MANOJ KUMAR S", "2026-06-02")!;
    expect(matchEmployee(parsed.name, employees).kind).toBe("none"); // so the dialog defaults to "create"
    const g = alreadyInPayroll({
      choice: "create", statementName: parsed.name, period: parsed.period, amount: 25000,
      salaries: [rec({})], employees,
    });
    expect(g).toEqual({ kind: "other_employee", employeeId: "manoj", period: "2026-05", net: 25000 });
  });

  it("same employee, same month, already paid → skipped", () => {
    expect(alreadyInPayroll({
      choice: "manoj", statementName: "MANOJ", period: "2026-05", amount: 25000,
      salaries: [rec({ paid_amount: 25000, paid_status: "paid" })], employees,
    })).toEqual({ kind: "paid", employeeId: "manoj", period: "2026-05" });
  });

  it("same employee, same month, booked but unpaid → NOT skipped: the line links to that record (no second record)", () => {
    expect(alreadyInPayroll({
      choice: "manoj", statementName: "MANOJ", period: "2026-05", amount: 25000, salaries: [rec({})], employees,
    })).toBeNull();
  });

  it("month assumed one off: May booked + unpaid, line read as June for the same amount → skipped, points to May", () => {
    expect(alreadyInPayroll({
      choice: "manoj", statementName: "MANOJ", period: "2026-06", amount: 25000, salaries: [rec({})], employees,
    })).toEqual({ kind: "other_month", employeeId: "manoj", period: "2026-05", remaining: 25000 });
  });

  it("a different amount next month is a real new month — not skipped", () => {
    expect(alreadyInPayroll({
      choice: "manoj", statementName: "MANOJ", period: "2026-06", amount: 27000, salaries: [rec({})], employees,
    })).toBeNull();
  });

  it("previous month already PAID does not block this month's line of the same amount", () => {
    expect(alreadyInPayroll({
      choice: "manoj", statementName: "MANOJ", period: "2026-06", amount: 25000,
      salaries: [rec({ paid_amount: 25000, paid_status: "paid" })], employees,
    })).toBeNull();
  });

  it("a genuinely new person (no shared name) with the same salary as someone → not skipped", () => {
    expect(alreadyInPayroll({
      choice: "create", statementName: "PRATIK SHARMA", period: "2026-05", amount: 25000, salaries: [rec({})], employees,
    })).toBeNull();
  });

  it("shared first name but a different amount → not skipped (could be another Manoj)", () => {
    expect(alreadyInPayroll({
      choice: "create", statementName: "MANOJ VERMA", period: "2026-05", amount: 41000, salaries: [rec({})], employees,
    })).toBeNull();
  });

  it("paise rounding (±₹1) still counts as the same amount", () => {
    expect(alreadyInPayroll({
      choice: "create", statementName: "MANOJ KUMAR S", period: "2026-05", amount: 25001, salaries: [rec({})], employees,
    })?.kind).toBe("other_employee");
  });

  it("year boundary: Dec booked, line read as Jan", () => {
    expect(alreadyInPayroll({
      choice: "manoj", statementName: "MANOJ", period: "2027-01", amount: 25000,
      salaries: [rec({ period: "2026-12" })], employees,
    })).toMatchObject({ kind: "other_month", period: "2026-12" });
  });
});
