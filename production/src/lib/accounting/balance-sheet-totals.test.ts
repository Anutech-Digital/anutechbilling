/**
 * R-179 — customer se mila paisa jo kisi bank line se match nahi hua, Balance Sheet par
 * asset ke roop me dikhna chahiye ("Undeposited funds"). Pehle sirf liability (Advances
 * from customers) dikhti thi aur Cash & bank ₹0 — Net worth ₹-57,490, Trial Balance me farq.
 *
 * Asli case (6 Oct, Demo workspace, koi bank account nahi): Acme Test Pvt Ltd ke do receipt
 * ₹38,232 + ₹19,258 = ₹57,490, quote par abhi invoice nahi.
 */
import { describe, it, expect } from "vitest";
import { balanceSheetTotals } from "./balance-sheet-totals";
import { buildTrialBalance } from "./trial-balance";
import type { BalanceSheetAuto } from "@/lib/queries/balance-sheet";
import type { PnLNumbers } from "./pnl-assemble";
import { balanceSheetFromRpc, type BalanceSheetRpcRow } from "./report-rpc";

const ZERO: BalanceSheetAuto = {
  cashAndBank: 0, undepositedFunds: 0, receivables: 0, advancesFromCustomers: 0, projectReceivable: 0,
  tdsReceivable: 0, employeeLoans: 0, prepaidAdvances: 0, fixedAssets: 0, payables: 0,
  salaryPayable: 0, salaryDuesPayable: 0, reimbursementsPayable: 0, creditCardPayable: 0,
  emiLoansPayable: 0, businessLoansPayable: 0, gstPayable: 0, gstPaid: 0, advanceTaxPaid: 0,
  fyLabel: "FY 2026-27",
};
const NO_PNL = { revenue: 0, cogs: 0, commissions: 0, expenses: 0, expensesByCategory: [] } as unknown as PnLNumbers;

/** Demo workspace: ₹57,490 advance mila, bank account hi nahi. */
const demo: BalanceSheetAuto = { ...ZERO, advancesFromCustomers: 57490, undepositedFunds: 57490 };

describe("R-179 — receipts not yet in a bank account", () => {
  it("balance sheet: the money received is an asset, so net worth is not negative", () => {
    const t = balanceSheetTotals(demo, []);
    expect(t.totalAssets).toBe(57490);
    expect(t.totalLiab).toBe(57490);
    expect(t.netWorth).toBe(0);
    // double-entry: assets = liabilities + equity
    expect(t.totalAssets).toBe(t.totalLiab + t.netWorth);
  });

  it("current ratio counts it as a current asset", () => {
    const t = balanceSheetTotals(demo, []);
    expect(t.currentAssets).toBe(57490);
    expect(t.currentRatio).toBe(1);
  });

  it("trial balance: shows it as its own Dr line and needs no difference line", () => {
    const tb = buildTrialBalance({ bs: demo, pnl: NO_PNL, items: [] });
    const row = tb.rows.find((r) => r.head === "Received, not yet in bank");
    expect(row).toMatchObject({ group: "Assets", debit: 57490, credit: 0 });
    expect(tb.difference).toBe(0);
    expect(tb.rows.some((r) => r.group === "Difference")).toBe(false);
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });

  it("does not move anything when every receipt is already matched to a bank line", () => {
    const banked: BalanceSheetAuto = { ...ZERO, cashAndBank: 57490, advancesFromCustomers: 57490 };
    const t = balanceSheetTotals(banked, []);
    expect(t.totalAssets).toBe(57490);
    expect(t.netWorth).toBe(0);
  });

  it("GST sign and manual lines go to the right side", () => {
    const t = balanceSheetTotals({ ...demo, gstPayable: -1000 }, [
      { id: "1", section: "asset", label: "Deposit", amount: 500, sort_order: 0, notes: null },
      { id: "2", section: "liability", label: "Loan", amount: 300, sort_order: 0, notes: null },
      { id: "3", section: "equity", label: "Capital", amount: 1200, sort_order: 0, notes: null },
    ]);
    expect(t.gstCredit).toBe(1000);
    expect(t.gstPayable).toBe(0);
    expect(t.totalAssets).toBe(57490 + 1000 + 500);
    expect(t.totalLiab).toBe(57490 + 300);
    expect(t.netWorth).toBe(1200);
    expect(t.retained).toBe(0);
  });
});

describe("R-179 — report_balance_sheet → undepositedFunds", () => {
  const row = (extra: Partial<BalanceSheetRpcRow>): BalanceSheetRpcRow => ({
    as_of: "2026-10-06", fy_start_year: 2026, fy_label: "FY 2026-27",
    cash_and_bank: 0, credit_card_payable: 0, receivables: 0, advances_from_customers: 57490,
    project_receivable: 0, tds_receivable: 0, employee_loans: 0, prepaid_advances: 0,
    emi_unregistered_cost: 0, emi_loans_payable: 0, business_loans_payable: 0, payables: 0,
    salary_payable: 0, dues_salary_tds: 0, dues_pf: 0, dues_esi: 0, dues_vendor_tds: 0, dues_paid: [],
    reimbursements_payable: 0, gst_output: 0, bills_gst: 0, itc_groups: [], fixed_assets: [], tax_payments: [],
    ...extra,
  });

  it("carries the SQL figure through", () => {
    const bs = balanceSheetFromRpc(row({ undeposited_funds: 57490 }));
    expect(bs.undepositedFunds).toBe(57490);
    expect(balanceSheetTotals(bs, []).netWorth).toBe(0);
  });

  it("before the migration (no column) it stays 0 — never NaN", () => {
    expect(balanceSheetFromRpc(row({})).undepositedFunds).toBe(0);
  });
});
