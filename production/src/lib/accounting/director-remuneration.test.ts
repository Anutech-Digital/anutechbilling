/**
 * R-1852 — a director's salary paid through Payroll is shown on the P&L as "Director's
 * Remuneration", apart from Salaries (Schedule III discloses it separately; ITR-6 asks for it).
 * Written before director-remuneration.ts.
 */
import { describe, it, expect } from "vitest";
import {
  moveDirectorPayroll, DIRECTOR_REMUNERATION_CATEGORY, directorPaidByExpenseCaution, pnlCategoryOf,
  type DirectorPayrollExpense,
} from "./director-remuneration";
import { assemblePnl, type PnlRpcRow, type PnlMasters } from "./pnl-assemble";

const RANGE = { from: "2026-04-01", to: "2027-03-31" };
const g = (category: string | null, vendor_name: string | null, month: string, amount: number, n = 1) =>
  ({ category, vendor_name, month, amount, n });

describe("moveDirectorPayroll — the P&L line", () => {
  const groups = [
    g("Salaries", "Asha Verma", "2026-09", 150000),
    g("Salaries", "Ravi Staff", "2026-09", 40000),
    g("Salaries", "Asha Verma", "2026-10", 150000),
    g("Hosting", "AWS", "2026-09", 5000, 2),
  ];
  const asha: DirectorPayrollExpense[] = [
    { expense_date: "2026-09-30", vendor_name: "Asha Verma", amount: 150000 },
    { expense_date: "2026-10-31", vendor_name: "Asha Verma", amount: 150000 },
  ];

  it("moves the director's payroll rows from Salaries to Director's Remuneration; the total is unchanged", () => {
    const out = moveDirectorPayroll(groups, asha, RANGE);
    const sum = (c: string) => out.filter((x) => x.category === c).reduce((s, x) => s + x.amount, 0);
    expect(sum("Salaries")).toBe(40000);
    expect(sum(DIRECTOR_REMUNERATION_CATEGORY)).toBe(300000);
    expect(out.reduce((s, x) => s + x.amount, 0)).toBe(groups.reduce((s, x) => s + x.amount, 0));
    expect(out.find((x) => x.category === DIRECTOR_REMUNERATION_CATEGORY && x.month === "2026-09")).toMatchObject({ vendor_name: "Asha Verma", n: 1 });
    expect(out.some((x) => x.amount === 0)).toBe(false);
  });

  it("joins an existing Director's Remuneration row (sitting fees booked as an expense) — one line", () => {
    const out = moveDirectorPayroll([...groups, g(DIRECTOR_REMUNERATION_CATEGORY, "Asha Verma", "2026-09", 10000)], asha, RANGE);
    expect(out.find((x) => x.category === DIRECTOR_REMUNERATION_CATEGORY && x.month === "2026-09")).toMatchObject({ amount: 160000, n: 2 });
  });

  it("only rows inside the period move", () => {
    const out = moveDirectorPayroll(groups, asha, { from: "2026-10-01", to: "2026-10-31" });
    expect(out.find((x) => x.category === "Salaries" && x.vendor_name === "Asha Verma" && x.month === "2026-09")?.amount).toBe(150000);
    expect(out.find((x) => x.category === DIRECTOR_REMUNERATION_CATEGORY)?.amount).toBe(150000);
  });

  it("never makes a negative Salaries row: a payroll row the report does not have is skipped", () => {
    const out = moveDirectorPayroll([g("Salaries", "Asha Verma", "2026-09", 100000)], [asha[0]], RANGE);
    expect(out).toEqual([g("Salaries", "Asha Verma", "2026-09", 100000)]);
  });

  it("no director payroll → the groups exactly as they were", () => {
    expect(moveDirectorPayroll(groups, [], RANGE)).toEqual(groups);
  });
});

describe("pnlCategoryOf — the drill-down lists a line's own rows", () => {
  const ids = new Set(["EXP-ASHA"]);
  it("a director payroll row is under Director's Remuneration; other rows keep their category", () => {
    expect(pnlCategoryOf({ id: "EXP-ASHA", category: "Salaries" }, ids)).toBe(DIRECTOR_REMUNERATION_CATEGORY);
    expect(pnlCategoryOf({ id: "EXP-RAVI", category: "Salaries" }, ids)).toBe("Salaries");
    expect(pnlCategoryOf({ id: "EXP-ASHA", category: "Hosting" }, ids)).toBe("Hosting");
  });
});

describe("assemblePnl — the P&L page, trial balance and ITR all read the moved line", () => {
  it("Director's Remuneration ₹1,50,000 apart from Salaries ₹40,000; expenses and net profit unchanged", () => {
    const groups = [g("Salaries", "Asha Verma", "2026-10", 150000), g("Salaries", "Ravi Staff", "2026-10", 40000)];
    const row: PnlRpcRow = {
      inv_taxable: 500000, inv_tax: 90000, revenue_count: 2, cn_taxable: 0, cn_tax: 0, dn_taxable: 0, dn_tax: 0,
      revenue_by_project: [], cogs: 0, cogs_count: 0, bills_gst: 0,
      expense_groups: groups, itc_groups: [], bill_itc_groups: [],
      unassigned_by_category: groups.map((x) => ({ category: x.category, amount: x.amount })),
      project_expenses: [], commissions: 0, commissions_count: 0,
    };
    const base: PnlMasters = { vendors: [], allocations: [], monthlyGross: new Map(), projects: [], employeeNames: new Map() };
    const range = { from: "2026-10-01", to: "2026-10-31" };
    const before = assemblePnl(range, row, base);
    const after = assemblePnl(range, row, { ...base, directorPayroll: [{ expense_date: "2026-10-31", vendor_name: "Asha Verma", amount: 150000 }] });
    expect(after.expensesByCategory).toEqual([
      { category: DIRECTOR_REMUNERATION_CATEGORY, total: 150000, count: 1 },
      { category: "Salaries", total: 40000, count: 1 },
    ]);
    expect(after.expenses).toBe(before.expenses);
    expect(after.netProfit).toBe(before.netProfit);
  });
});

describe("directorPaidByExpenseCaution — a director's salary belongs in Payroll", () => {
  const directors = [{ name: "Asha Verma", ceased_on: null, employee_id: "e1" }, { name: "Bimal Rao", ceased_on: null, employee_id: null }];

  it("Pvt Ltd: Director's Remuneration to a director who is on the payroll → caution with the Payroll way", () => {
    const c = directorPaidByExpenseCaution({ businessType: "pvt_ltd", category: DIRECTOR_REMUNERATION_CATEGORY, payee: "asha verma", text: "", directors, onDate: "2026-10-25" })!;
    expect(c.title).toBe("Asha Verma is on the payroll — pay the salary through Payroll");
    expect(c.body).toMatch(/TDS on salary \(section 192\)/);
    expect(c.body).toMatch(/194J/);
  });

  it("'director salary' typed as an expense (any category) → caution even without a register match", () => {
    const c = directorPaidByExpenseCaution({ businessType: null, category: "Salaries", payee: "", text: "Director salary for Oct", directors: [], onDate: "2026-10-25" });
    expect(c?.title).toBe("A director's salary goes through Payroll");
  });

  it("sitting fees to a director who is NOT on the payroll → no caution (194J expense is right)", () => {
    expect(directorPaidByExpenseCaution({ businessType: "pvt_ltd", category: DIRECTOR_REMUNERATION_CATEGORY, payee: "Bimal Rao", text: "sitting fees", directors, onDate: "2026-10-25" })).toBeNull();
  });

  it("not a company → nothing (the proprietor / partner caution is R-1846's)", () => {
    expect(directorPaidByExpenseCaution({ businessType: "proprietor", category: DIRECTOR_REMUNERATION_CATEGORY, payee: "Asha Verma", text: "director salary", directors, onDate: "2026-10-25" })).toBeNull();
  });

  it("a ceased director does not match", () => {
    const ceased = [{ name: "Asha Verma", ceased_on: "2026-06-30", employee_id: "e1" }];
    expect(directorPaidByExpenseCaution({ businessType: "pvt_ltd", category: DIRECTOR_REMUNERATION_CATEGORY, payee: "Asha Verma", text: "", directors: ceased, onDate: "2026-10-25" })).toBeNull();
  });
});
