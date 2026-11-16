import { describe, it, expect } from "vitest";
import {
  salaryMonthRows, employeeLoansFor, waitingSalaryNets, outstandingLoanTotal,
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

  it("deductions come from the stored net, so LOP above the gross still adds up", () => {
    const [r] = salaryMonthRows([row({ gross: 30000, lop_amount: 31000, incentive: 5000, pf: 0, net: 5000 })]);
    expect(r).toMatchObject({ gross: 35000, deductions: 30000, net: 5000 });
    expect(r.gross - r.deductions).toBe(r.net);
  });

  it("no salary → empty list", () => {
    expect(salaryMonthRows([])).toEqual([]);
  });
  it("an imported row whose net does not follow the columns still adds up (deductions = gross + bonus − net)", () => {
    const [r] = salaryMonthRows([row({ gross: 30000, pf: 1800, net: 29000 })]);
    expect(r.gross - r.deductions).toBe(29000);
  });
});

describe("R-2701 waitingSalaryNets — the Salary Register's rule for which nets may have an unlinked bank line", () => {
  it("unpaid salaries and Paid ones with no bank line on record; not part-paid or linked", () => {
    expect(waitingSalaryNets([
      row({ net: 100 }),
      row({ net: 200, paid_status: "paid", paid_amount: 200, reconciled_txn_id: null }),
      row({ net: 300, paid_status: "paid", paid_amount: 300, reconciled_txn_id: "t1" }),
      row({ net: 400, paid_status: "partial", paid_amount: 50 }),
    ])).toEqual([100, 200]);
  });
});

describe("R-2701 outstandingLoanTotal", () => {
  it("adds what is still due on active loans; a repaid or closed loan adds nothing", () => {
    expect(outstandingLoanTotal([
      { outstanding: 5000, status: "active" }, { outstanding: 0, status: "active" }, { outstanding: -10, status: "active" },
      { outstanding: 2500, status: "active" }, { outstanding: 9000, status: "closed" },
    ])).toBe(7500);
    expect(outstandingLoanTotal([])).toBe(0);
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
