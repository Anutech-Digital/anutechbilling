/**
 * R-2674 — loans given / staff loans due back within 12 months count as CURRENT assets.
 * Owner case (11 Nov 2026): loans given 29.8L + staff loan 8L sat outside current assets, so the
 * current ratio fell from 1.88 to 1.66. Total assets / net worth must not move at all.
 */
import { describe, it, expect } from "vitest";
import { balanceSheetTotals } from "./balance-sheet-totals";
import { loansAdvancesSplit, loanSplitLines } from "./loans-current-split";
import type { BalanceSheetAuto } from "@/lib/queries/balance-sheet";

const ZERO: BalanceSheetAuto = {
  cashAndBank: 0, undepositedFunds: 0, receivables: 0, advancesFromCustomers: 0, projectReceivable: 0,
  tdsReceivable: 0, employeeLoans: 0, prepaidAdvances: 0, fixedAssets: 0, payables: 0,
  salaryPayable: 0, salaryDuesPayable: 0, reimbursementsPayable: 0, creditCardPayable: 0,
  emiLoansPayable: 0, businessLoansPayable: 0, gstPayable: 0, gstPaid: 0, advanceTaxPaid: 0,
  expensesPayable: 0, expensesPaidUnbanked: 0, salaryOtherDeductions: 0,
  fyLabel: "FY 2026-27",
};

/* Current assets 28,22,000 without the loans; current liabilities 17,00,000 → 1.66.
   With the 37,80,000 of loans counted nothing else changes. */
const books: BalanceSheetAuto = {
  ...ZERO, cashAndBank: 2_000_000, receivables: 822_000, payables: 1_700_000,
  loansGiven: 2_980_000, employeeLoans: 800_000,
  emiLoansPayable: 500_000, businessLoansPayable: 900_000,
};
const answered = { loansGiven: 2_980_000, employeeLoans: 800_000, undecidedCount: 0, undecidedAmount: 0 };

describe("R-2674 balanceSheetTotals — the current ratio uses the loans split", () => {
  it("before any answer (or an older database): loans stay outside current assets, as before", () => {
    const t = balanceSheetTotals(books, []);
    expect(t.currentAssets).toBe(2_822_000);
    expect(t.currentRatio).toBeCloseTo(1.66, 2);
    expect(balanceSheetTotals({ ...books, loansCurrent: null }, []).currentAssets).toBe(2_822_000);
  });

  it("ratio uses the split: loans due within 12 months are current — totals unchanged", () => {
    const before = balanceSheetTotals(books, []);
    const after = balanceSheetTotals({ ...books, loansCurrent: answered }, []);
    expect(after.currentAssets).toBe(2_822_000 + 3_780_000);
    expect(after.currentRatio).toBeCloseTo(6_602_000 / 1_700_000, 6);
    expect(after.totalAssets).toBe(before.totalAssets);
    expect(after.totalLiab).toBe(before.totalLiab);
    expect(after.netWorth).toBe(before.netWorth);
    expect(after.retained).toBe(before.retained);
    expect(after.debtToEquity).toBe(before.debtToEquity);
  });

  it("changing one answer moves only that amount between current and non-current", () => {
    const part = balanceSheetTotals({ ...books, loansCurrent: { ...answered, loansGiven: 1_980_000 } }, []);
    expect(part.currentAssets).toBe(2_822_000 + 1_980_000 + 800_000);
    expect(part.totalAssets).toBe(balanceSheetTotals(books, []).totalAssets);
  });

  it("currentLiab unchanged — loans TAKEN (EMI, business loans) are out of scope", () => {
    const before = balanceSheetTotals(books, []);
    const after = balanceSheetTotals({ ...books, loansCurrent: answered }, []);
    expect(after.currentLiab).toBe(before.currentLiab);
    expect(after.currentLiab).toBe(1_700_000);
  });

  it("a current figure above the line (over-repaid books) never lifts current assets past the line", () => {
    const t = balanceSheetTotals({ ...books, loansGiven: 3_000, employeeLoans: 0, loansCurrent: { ...answered, loansGiven: 10_000, employeeLoans: 9_999 } }, []);
    expect(t.currentAssets).toBe(2_822_000 + 3_000);
  });

  it("csv lines add up to the old line, and their current rows are what the ratio counted", () => {
    const auto = { ...books, loansCurrent: { ...answered, loansGiven: 1_980_000 } };
    const split = loansAdvancesSplit(auto);
    const lines = loanSplitLines(split);
    expect(lines.reduce((s, l) => s + l.amount, 0)).toBe(2_980_000 + 800_000);
    const withoutLoans = balanceSheetTotals({ ...auto, loansCurrent: null }, []).currentAssets;
    expect(balanceSheetTotals(auto, []).currentAssets - withoutLoans)
      .toBe(lines.filter((l) => l.current).reduce((s, l) => s + l.amount, 0));
  });
});
