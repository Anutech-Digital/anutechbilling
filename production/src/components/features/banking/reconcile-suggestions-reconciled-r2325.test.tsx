// @vitest-environment jsdom
/* R-2325 — Banking → Reconcile: "Suggested matches" hides expenses already reconciled to another
   bank line (the dialog's own wiring; the read and the filter are in lib/banking/reconciled-suggestions).
   Staging money-out reconcile, 31 Oct: a line suggested an expense an earlier bank line of the same
   amount had already been reconciled to — matching it again counts one bill twice. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { BankTransactionRow } from "@/lib/queries/bank";

const state = vi.hoisted(() => ({
  suggestions: [] as unknown[],
  reconciled: new Set<string>(),
}));
const { mutation } = vi.hoisted(() => ({ mutation: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }) }));

/* The real filter; only the read of which expenses are reconciled is stubbed. */
vi.mock("@/lib/banking/reconciled-suggestions", async (orig) => ({
  ...(await orig<typeof import("@/lib/banking/reconciled-suggestions")>()),
  useReconciledExpenseIds: () => ({ data: state.reconciled, isLoading: false }),
}));
vi.mock("@/lib/queries/customer-payers", () => ({
  usePayerMemory: () => ({ payers: [], ownNames: [] }),
  useSetBankLinePayer: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/queries/bank", () => ({
  useSuggestMatches: () => ({ data: state.suggestions, isLoading: false }),
  useReconcileTransaction: mutation,
  useReconcileExpensesToBankTxn: mutation,
  useBookTxnAsExpense: mutation,
  useBookBankCredit: mutation,
  useBookBankAdvance: mutation,
  useBookBankTxnAsStatutory: mutation,
  useBookBankTxnAsCommission: mutation,
  useReconcileSalaryAdvanceSplit: mutation,
  useOpenInvoicesForCreditMatch: () => ({ data: [] }),
}));
vi.mock("@/lib/queries/expenses", () => ({
  EXPENSE_CATEGORIES: ["Software", "Bank Charges", "Salaries", "Other"],
  useUnreconciledExpenses: () => ({ data: [] }),
  suggestCategory: () => null,
}));
vi.mock("@/lib/queries/txn-category-rules", () => ({ useTxnCategoryRules: () => ({ data: [] }) }));
vi.mock("@/lib/queries/payroll", () => ({ useUnreconciledSalaries: () => ({ data: [] }), useEmployees: () => ({ data: [] }) }));
vi.mock("@/lib/queries/customers", () => ({ useCustomers: () => ({ data: [] }) }));
vi.mock("@/lib/queries/tax-payments", () => ({ useBookBankTxnAsTax: mutation }));
vi.mock("@/lib/queries/salary-from-bank", () => ({ useBookSalaryLines: mutation }));
vi.mock("@/lib/queries/prepaid-advances", () => ({ usePrepaidAdvances: () => ({ data: [] }) }));
vi.mock("@/lib/queries/referral-commissions", () => ({ useReferralCommissions: () => ({ data: [] }) }));
vi.mock("@/components/features/banking/reconcile-suggestion-card", () => ({
  useReconcileSuggestion: () => ({ suggestion: null, accept: async () => false, accepting: false }),
  SuggestionCard: () => null,
  logSuggestion: () => {},
}));
vi.mock("@/lib/compliance/profile", () => ({ useComplianceProfile: () => ({ data: { businessType: "pvt_ltd" } }) }));
vi.mock("@/components/features/customers/add-customer-form", () => ({ AddCustomerForm: () => null }));
vi.mock("@/components/features/banking/project-payment-section", () => ({ ProjectPaymentSection: () => null }));
vi.mock("@/components/features/banking/credit-pay-for-section", () => ({ CreditPayForSection: () => null }));
vi.mock("@/components/features/banking/owner-equity-section", () => ({ OwnerEquitySection: () => null }));
vi.mock("@/components/features/banking/other-income-section", () => ({ OtherIncomeSection: () => null }));
vi.mock("@/components/features/banking/own-transfer-section", () => ({ OwnTransferSection: () => null }));
vi.mock("@/components/features/banking/incentive-from-bank-section", () => ({ IncentiveFromBankSection: () => null }));
vi.mock("@/components/features/banking/employee-advance-bank-section", () => ({ EmployeeAdvanceBankSection: () => null }));
vi.mock("@/components/features/banking/emi-repayment-section", () => ({ EmiRepaymentSection: () => null }));
vi.mock("@/components/features/banking/debit-pay-for-section", () => ({ DebitPayForSection: () => null }));

import { ReconcileTransactionDialog } from "./reconcile-transaction-dialog";

const line = {
  id: "t2", bank_account_id: "b1", txn_date: "2026-07-08", description: "UPI 9876@okhdfc",
  debit: 1416, credit: 0, reference: null, category: null,
} as unknown as BankTransactionRow;
const sug = (id: string, label: string) =>
  ({ match_type: "expense", match_id: id, match_label: label, match_amount: 1416, match_date: "2026-06-08", match_confidence: "high" });

afterEach(cleanup);
beforeEach(() => {
  state.reconciled = new Set();
  state.suggestions = [sug("E-JUN", "Zoho · June autopay"), sug("E-JUL", "Zoho · July autopay")];
});

describe("R-2325 Suggested matches never offer an expense already reconciled", () => {
  it("an expense reconciled to another bank line is not suggested; the open one still is", () => {
    state.reconciled = new Set(["E-JUN"]);
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={line} />);
    expect(screen.getByText("Suggested matches")).toBeTruthy();
    expect(screen.queryByText("Zoho · June autopay")).toBeNull();
    expect(screen.getByText("Zoho · July autopay")).toBeTruthy();
  });

  it("every suggested expense already reconciled → no Suggested matches box at all", () => {
    state.reconciled = new Set(["E-JUN", "E-JUL"]);
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={line} />);
    expect(screen.queryByText("Suggested matches")).toBeNull();
    expect(screen.getByText(/No close matches in your books/)).toBeTruthy();
  });

  it("nothing reconciled elsewhere → both expenses are suggested (no over-filtering)", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={line} />);
    expect(screen.getByText("Zoho · June autopay")).toBeTruthy();
    expect(screen.getByText("Zoho · July autopay")).toBeTruthy();
  });
});
