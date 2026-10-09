import { describe, it, expect } from "vitest";
import { buildTrialBalance, trialBalanceCsvRows } from "./trial-balance";
import type { BalanceSheetAuto, BalanceSheetItem } from "@/lib/queries/balance-sheet";
import type { PnLNumbers } from "./pnl-assemble";

const bs: BalanceSheetAuto = {
  cashAndBank: 130500, undepositedFunds: 0, receivables: 15900, advancesFromCustomers: 7000, projectReceivable: 30000,
  tdsReceivable: 1500, employeeLoans: 15000, prepaidAdvances: 8000, fixedAssets: 84000,
  payables: 10000, salaryPayable: 20000, salaryDuesPayable: 6450, reimbursementsPayable: 1500,
  creditCardPayable: 8000, emiLoansPayable: 40000, businessLoansPayable: 75000,
  gstPayable: 10137, gstPaid: 1000, advanceTaxPaid: 5000,
  expensesPayable: 0, expensesPaidUnbanked: 0, salaryOtherDeductions: 0, fyLabel: "FY 2026-27",
};
const pnl = {
  revenue: 76873, cogs: 10000, commissions: 2000,
  expenses: 64480 - 1800,             // gross 64480 − eligible ITC 1800
  expensesByCategory: [
    { category: "Salaries", total: 28000, count: 1 },
    { category: "Rent", total: 20000, count: 1 },
    { category: "Software", total: 14800, count: 2 },
    { category: "Staff Welfare", total: 1180, count: 1 },
    { category: "Uncategorised", total: 500, count: 1 },
  ],
} as unknown as PnLNumbers;
const items: BalanceSheetItem[] = [
  { id: "1", section: "equity", label: "Share capital", amount: 100000, sort_order: 0, notes: null },
  { id: "2", section: "asset", label: "Security deposit", amount: 25000, sort_order: 0, notes: null },
];

describe("buildTrialBalance", () => {
  const tb = buildTrialBalance({ bs, pnl, items });
  const row = (head: string) => tb.rows.find((r) => r.head === head);

  it("always tallies — through a labelled difference line, never silently", () => {
    expect(tb.totalDebit).toBe(tb.totalCredit);
    const diff = row("Difference — opening capital & retained earnings b/f")!;
    expect(diff.group).toBe("Difference");
    expect(Math.abs(tb.difference)).toBe(diff.debit + diff.credit);
  });

  it("puts every head in its natural column with the exact amount", () => {
    expect(row("Cash & bank")).toMatchObject({ debit: 130500, credit: 0 });
    expect(row("Security deposit")).toMatchObject({ debit: 25000 });
    expect(row("Share capital")).toMatchObject({ credit: 100000 });
    expect(row("Sales (net of credit / debit notes)")).toMatchObject({ credit: 76873 });
    expect(row("GST payable")).toMatchObject({ credit: 10137 });
    expect(row("Rent")).toMatchObject({ debit: 20000 });
  });

  it("nets expense heads to the P&L figure via one ITC line", () => {
    expect(row("Less: ITC inside the expenses above")).toMatchObject({ debit: 0, credit: 1800 });
    const expenseDr = tb.rows.filter((r) => r.group === "Expenses").reduce((s, r) => s + r.debit - r.credit, 0);
    expect(expenseDr).toBe(pnl.cogs + pnl.expenses + pnl.commissions);
  });

  it("the hand-computed difference", () => {
    // Dr: 130500+15900+30000+1500+15000+8000+84000+5000+25000 + 10000+64480+2000 − ITC 1800(Cr)
    const dr = 314900 + 10000 + 64480 + 2000;
    // Cr: 10000+7000+20000+6450+1500+8000+40000+75000+10137 + 100000 + 76873 + 1800
    const cr = 178087 + 100000 + 76873 + 1800;
    expect(tb.difference).toBe(dr - cr);
  });

  it("a negative balance flips column instead of printing a minus", () => {
    const t = buildTrialBalance({ bs: { ...bs, gstPayable: -4200, cashAndBank: -300 }, pnl, items: [] });
    expect(t.rows.find((r) => r.head === "GST input credit carried forward")).toMatchObject({ debit: 4200, credit: 0 });
    expect(t.rows.find((r) => r.head === "Cash & bank")).toMatchObject({ debit: 0, credit: 300 });
    expect(t.rows.every((r) => r.debit >= 0 && r.credit >= 0)).toBe(true);
  });

  it("zero heads are left out; CSV ends with equal totals", () => {
    const t = buildTrialBalance({ bs: { ...bs, reimbursementsPayable: 0 }, pnl, items });
    expect(t.rows.some((r) => r.head === "Reimbursements payable")).toBe(false);
    const last = trialBalanceCsvRows(t).at(-1)!;
    expect(last[2]).toBe(last[3]);
  });
});

describe("buildTrialBalance — S45 slice 2 heads + CA opening balances", () => {
  const base = buildTrialBalance({ bs, pnl, items });

  it("unpaid expenses, cash expenses not yet in bank and salary 'other' deductions each shrink the Difference by exactly their amount", () => {
    const t = buildTrialBalance({
      bs: { ...bs, expensesPayable: 2000, expensesPaidUnbanked: 500, salaryOtherDeductions: 300 }, pnl, items,
    });
    expect(t.rows.find((r) => r.head === "Expenses payable")).toMatchObject({ debit: 0, credit: 2000 });
    expect(t.rows.find((r) => r.head === "Less: expenses paid, not yet matched in bank")).toMatchObject({ debit: 0, credit: 500 });
    expect(t.rows.find((r) => r.head === "Salary deductions held (other)")).toMatchObject({ debit: 0, credit: 300 });
    expect(t.difference).toBe(base.difference - 2800);
    expect(t.totalDebit).toBe(t.totalCredit);
  });

  it("no opening balances → no Equity opening rows, Difference label unchanged", () => {
    const t = buildTrialBalance({ bs, pnl, items, opening: null });
    expect(t.rows.some((r) => r.head.startsWith("Owner's capital (opening"))).toBe(false);
    expect(t.rows.some((r) => r.head === "Difference — opening capital & retained earnings b/f")).toBe(true);
  });

  it("CA's opening balances sit in Equity and take that much out of the Difference", () => {
    const opening = { asOf: "2026-03-31", ownerCapital: 50000, retainedEarnings: -12000, notes: null };
    const t = buildTrialBalance({ bs, pnl, items, opening });
    expect(t.rows.find((r) => r.head === "Owner's capital (opening, from CA)")).toMatchObject({ group: "Equity", credit: 50000 });
    // a loss b/f flips to the debit column
    expect(t.rows.find((r) => r.head === "Retained earnings b/f (from CA)")).toMatchObject({ debit: 12000, credit: 0 });
    expect(t.difference).toBe(base.difference - 50000 + 12000);
    expect(t.totalDebit).toBe(t.totalCredit);
    expect(t.rows.some((r) => r.head === "Difference — not explained by records or opening balances")).toBe(t.difference !== 0);
  });

  it("opening figures that exactly explain the gap leave no Difference line", () => {
    const opening = { asOf: "2026-03-31", ownerCapital: base.difference, retainedEarnings: null, notes: null };
    const t = buildTrialBalance({ bs, pnl, items, opening });
    expect(t.difference).toBe(0);
    expect(t.rows.some((r) => r.group === "Difference")).toBe(false);
  });
});
