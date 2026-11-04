/**
 * R-2095 (30 Oct 2026, September reconcile): FD / savings interest credited by the bank reached no
 * income line — the P&L missed it. A bank line booked as other income (other_incomes, migration
 * r2095_other_income_fd_transfer) comes back from report_pnl_other_income and is its own
 * "Other income" block, added to net profit after operating expenses.
 */
import { describe, it, expect } from "vitest";
import { assemblePnl, type PnlRpcRow, type PnlMasters } from "./pnl-assemble";

const range = { from: "2026-09-01", to: "2026-09-30" };
const masters: PnlMasters = { vendors: [], allocations: [], monthlyGross: new Map(), projects: [], employeeNames: new Map() };
const row = (extra: Partial<PnlRpcRow>): PnlRpcRow => ({
  inv_taxable: 50000, inv_tax: 9000, revenue_count: 1, cn_taxable: 0, cn_tax: 0, dn_taxable: 0, dn_tax: 0,
  revenue_by_project: [], cogs: 10000, cogs_count: 1, bills_gst: 1800,
  expense_groups: [], itc_groups: [], unassigned_by_category: [], project_expenses: [],
  commissions: 0, commissions_count: 0, ...extra,
});

describe("R-2095 Other income in the P&L", () => {
  it("interest received adds to net profit and is listed by head", () => {
    const base = assemblePnl(range, row({}), masters);
    const p = assemblePnl(range, row({ other_income: [{ head: "interest", amount: 1234, n: 1 }] }), masters);
    expect(p.otherIncome).toBe(1234);
    expect(p.otherIncomeLines).toEqual([{ head: "interest", label: "Interest received", amount: 1234, count: 1 }]);
    expect(p.netProfit).toBe(base.netProfit + 1234);
    expect(p.model.netProfit).toBe(base.model.netProfit === null ? null : base.model.netProfit + 1234);
    expect(p.revenue).toBe(base.revenue);   // not a sale — revenue unchanged
  });
  it("absent (older database) → ₹0, no lines", () => {
    const p = assemblePnl(range, row({}), masters);
    expect(p.otherIncome).toBe(0);
    expect(p.otherIncomeLines).toEqual([]);
  });
});
