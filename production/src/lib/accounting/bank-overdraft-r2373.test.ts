/**
 * R-2373 — a negative Overdraft (OD / cash-credit) balance is a borrowing. report_balance_sheet
 * now sends it as `bank_overdraft` (left out of cash_and_bank); the Balance Sheet totals, the
 * Trial Balance and the Accounting home "You owe" carry it as a current liability.
 *
 * Owner example (OD audit, 2 Nov): HDFC current ₹2,00,000 + HDFC OD at −₹50,000.
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
  expensesPayable: 0, expensesPaidUnbanked: 0, salaryOtherDeductions: 0,
  fyLabel: "FY 2026-27",
};
const NO_PNL = { revenue: 0, cogs: 0, commissions: 0, expenses: 0, expensesByCategory: [] } as unknown as PnLNumbers;

const rpcBase: BalanceSheetRpcRow = {
  as_of: "2026-11-02", fy_start_year: 2026, fy_label: "FY 2026-27",
  cash_and_bank: 200000, credit_card_payable: 0, receivables: 0, advances_from_customers: 0,
  project_receivable: 0, tds_receivable: 0, employee_loans: 0, prepaid_advances: 0,
  emi_unregistered_cost: 0, emi_loans_payable: 0, business_loans_payable: 0, payables: 0,
  salary_payable: 0, dues_salary_tds: 0, dues_pf: 0, dues_esi: 0, dues_vendor_tds: 0, dues_paid: [],
  reimbursements_payable: 0, gst_output: 0, bills_gst: 0, itc_groups: [], fixed_assets: [], tax_payments: [],
};

describe("R-2373 — bank overdraft on the Balance Sheet", () => {
  it("the SQL figure carries through; before the migration (no column) it is 0, never NaN", () => {
    expect(balanceSheetFromRpc({ ...rpcBase, bank_overdraft: 50000 }).bankOverdraft).toBe(50000);
    expect(balanceSheetFromRpc(rpcBase).bankOverdraft).toBe(0);
  });

  it("OD at −50,000: a 50,000 current liability, cash stays 2,00,000, net worth unchanged", () => {
    const withOd = balanceSheetTotals({ ...ZERO, cashAndBank: 200000, bankOverdraft: 50000 }, []);
    expect(withOd.totalAssets).toBe(200000);
    expect(withOd.totalLiab).toBe(50000);
    expect(withOd.currentLiab).toBe(50000);
    expect(withOd.netWorth).toBe(150000);
    // same net worth as the old netted figure (cash 1,50,000, no liability) — only the split moved
    const netted = balanceSheetTotals({ ...ZERO, cashAndBank: 150000 }, []);
    expect(withOd.netWorth).toBe(netted.netWorth);
    expect(withOd.totalAssets).toBe(withOd.totalLiab + withOd.netWorth);
  });

  it("Trial Balance: 'Bank overdraft' is a credit under Liabilities and the TB still agrees", () => {
    const tb = buildTrialBalance({ bs: { ...ZERO, cashAndBank: 200000, bankOverdraft: 50000 }, pnl: NO_PNL, items: [] });
    const row = tb.rows.find((r) => r.head === "Bank overdraft");
    expect(row).toMatchObject({ group: "Liabilities", debit: 0, credit: 50000 });
    const cash = balanceSheetTotals({ ...ZERO, cashAndBank: 200000, bankOverdraft: 50000 }, []);
    const tbNoOd = buildTrialBalance({ bs: { ...ZERO, cashAndBank: 150000 }, pnl: NO_PNL, items: [] });
    expect(tb.difference).toBe(tbNoOd.difference);
    expect(cash.netWorth).toBe(150000);
  });

  it("OD in credit (bank_overdraft 0): no liability, nothing changes", () => {
    const t = balanceSheetTotals({ ...ZERO, cashAndBank: 210000, bankOverdraft: 0 }, []);
    expect(t.totalLiab).toBe(0);
    expect(t.netWorth).toBe(210000);
  });
});
