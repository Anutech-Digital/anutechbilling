import { describe, it, expect } from "vitest";
import {
  salaryMonthRows, bookedMonthsText, deleteBlockedMessage, employeeLoansFor,
  type SalaryMonthFacts,
} from "./employee-salary-months";

const row = (over: Partial<SalaryMonthFacts>): SalaryMonthFacts => ({
  id: "s1", period: "2026-09",
  gross: 30000, incentive: 0, lop_amount: 0, advance_recovered: 0,
  tds: 0, pf: 1800, esi: 0, other_deduction: 0, net: 28200,
  paid_amount: 0, paid_status: "unpaid", reconciled_txn_id: null, expense_id: null,
  ...over,
});

describe("R-2701 salaryMonthRows — one line per booked month for the employee profile", () => {
  it("newest month first; gross includes bonus, deductions = LOP + advance + TDS + PF + ESI + other, so gross − deductions = net", () => {
    const rows = salaryMonthRows([
      row({ id: "a", period: "2026-08", gross: 30000, net: 28200 }),
      row({
        id: "b", period: "2026-09", gross: 30000, incentive: 2000, lop_amount: 1000,
        advance_recovered: 500, tds: 300, pf: 1800, esi: 200, other_deduction: 100, net: 28100,
      }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
    expect(rows[0]).toMatchObject({ month: "Sep 2026", gross: 32000, deductions: 3900, net: 28100 });
    expect(rows[0].gross - rows[0].deductions).toBe(rows[0].net);
    expect(rows[1]).toMatchObject({ month: "Aug 2026", gross: 30000, deductions: 1800, net: 28200 });
  });

  it("paid state comes from the one salary-status helper (paid / partial / not paid yet)", () => {
    const rows = salaryMonthRows([
      row({ id: "p", period: "2026-07", paid_status: "paid", paid_amount: 28200 }),
      row({ id: "h", period: "2026-08", paid_amount: 10000 }),
      row({ id: "n", period: "2026-09" }),
    ]);
    expect(rows.map((r) => r.status.label)).toEqual(["Not paid yet", "Partial", "Paid"]);
  });

  it("no salary → empty list", () => {
    expect(salaryMonthRows([])).toEqual([]);
  });
});

describe("R-2701 bookedMonthsText — names the months in plain words", () => {
  it("one, two and many months, oldest first", () => {
    expect(bookedMonthsText(["2026-09"])).toBe("Sep 2026");
    expect(bookedMonthsText(["2026-10", "2026-09"])).toBe("Sep 2026 and Oct 2026");
    expect(bookedMonthsText(["2026-07", "2026-09", "2026-08"])).toBe("Jul 2026, Aug 2026 and Sep 2026");
  });

  it("the same month twice (two runs) is named once", () => {
    expect(bookedMonthsText(["2026-09", "2026-09"])).toBe("Sep 2026");
  });

  it("more than 6 months → first 6 and how many more", () => {
    const p = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];
    expect(bookedMonthsText(p)).toBe("Jan 2026, Feb 2026, Mar 2026, Apr 2026, May 2026, Jun 2026 and 2 more months");
  });
});

describe("R-2701 deleteBlockedMessage — the delete refusal names the months", () => {
  it("names the count and the months, and what to do instead", () => {
    expect(deleteBlockedMessage(["2026-09", "2026-10"])).toBe(
      "Salary is booked for 2 months (Sep 2026 and Oct 2026). Deleting would break those payslips and their bank links. Use Start exit instead — it marks them as left; their history stays and payroll stops after their last working day.",
    );
  });

  it("one month reads singular", () => {
    expect(deleteBlockedMessage(["2026-09"])).toContain("Salary is booked for 1 month (Sep 2026)");
  });
});

describe("R-2701 employeeLoansFor — loans/advances are stored by name", () => {
  it("matches the employee's name ignoring case and spaces; newest first", () => {
    const loans = [
      { id: "1", employee_name: " Prashant Kumar ", disbursed_on: "2026-08-01" },
      { id: "2", employee_name: "prashant kumar", disbursed_on: "2026-09-01" },
      { id: "3", employee_name: "Someone Else", disbursed_on: "2026-09-02" },
    ];
    expect(employeeLoansFor(loans, "Prashant  Kumar").map((l) => l.id)).toEqual(["2", "1"]);
  });
});
