// @vitest-environment jsdom
/* R-2095 follow-up (30 Oct 2026): Reconcile → money in → Other / manual. The Interest box above says
   interest goes to the P&L as Other income, but the "None of these match?" text under it still listed
   interest as a case to mark reconciled WITHOUT any entry — two texts telling the owner opposite
   things. On money in the manual text now sends interest to the box above. (Harness from
   reconcile-who-tiles-r2006.test.tsx.) */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import type { BankTransactionRow } from "@/lib/queries/bank";

const state = vi.hoisted(() => ({
  focus: null as unknown,
  suggestions: [] as unknown[],
  customers: [] as unknown[],
  bookExpense: vi.fn(),
  reconcile: vi.fn(),
  bookAdvance: vi.fn(),
}));
const { mutation } = vi.hoisted(() => ({ mutation: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }) }));

/* R-2025: no known payers, our own name (the payer warning / known-payer guess). */
vi.mock("@/lib/queries/customer-payers", () => ({
  usePayerMemory: () => ({ payers: [], ownNames: [] }),
  useSetBankLinePayer: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/queries/bank", () => ({
  useSuggestMatches: () => ({ data: state.suggestions, isLoading: false }),
  useReconcileTransaction: () => ({ mutateAsync: state.reconcile, isPending: false }),
  useReconcileExpensesToBankTxn: mutation,
  useBookTxnAsExpense: () => ({ mutateAsync: state.bookExpense, isPending: false }),
  useBookBankCredit: mutation,
  useBookBankAdvance: () => ({ mutateAsync: state.bookAdvance, isPending: false }),
  useBookBankTxnAsStatutory: mutation,
  useBookBankTxnAsCommission: mutation,
  useReconcileSalaryAdvanceSplit: mutation,
  useOpenInvoicesForCreditMatch: () => ({ data: [] }),
}));
vi.mock("@/lib/queries/expenses", () => ({
  EXPENSE_CATEGORIES: ["Professional Services", "Bank Charges", "Salaries", "Other"],
  useUnreconciledExpenses: () => ({ data: [] }),
  suggestCategory: () => null,
}));
vi.mock("@/lib/queries/txn-category-rules", () => ({ useTxnCategoryRules: () => ({ data: [] }) }));
vi.mock("@/lib/queries/payroll", () => ({ useUnreconciledSalaries: () => ({ data: [] }), useEmployees: () => ({ data: [] }) }));
vi.mock("@/lib/queries/customers", () => ({ useCustomers: () => ({ data: state.customers }) }));
vi.mock("@/lib/queries/tax-payments", () => ({ useBookBankTxnAsTax: mutation }));
vi.mock("@/lib/queries/salary-from-bank", () => ({ useBookSalaryLines: mutation }));
vi.mock("@/lib/queries/prepaid-advances", () => ({ usePrepaidAdvances: () => ({ data: [] }) }));
vi.mock("@/lib/queries/referral-commissions", () => ({ useReferralCommissions: () => ({ data: [] }) }));
vi.mock("@/lib/compliance/profile", () => ({ useComplianceProfile: () => ({ data: { businessType: "pvt_ltd" } }) }));
vi.mock("@/components/features/customers/add-customer-form", () => ({ AddCustomerForm: () => null }));
vi.mock("@/components/features/banking/project-payment-section", () => ({ ProjectPaymentSection: () => null }));
/* R-2007's Suggestion card has its own test (reconcile-suggestion-r2007.test.tsx); none here. */
vi.mock("@/components/features/banking/reconcile-suggestion-card", () => ({
  useReconcileSuggestion: () => ({ suggestion: null, accept: async () => false, accepting: false }),
  SuggestionCard: () => null,
  logSuggestion: () => {},
}));
vi.mock("@/components/features/banking/credit-pay-for-section", () => ({
  CreditPayForSection: () => <section aria-label="Customer payment form">Who paid?</section>,
}));
vi.mock("@/components/features/banking/owner-equity-section", () => ({ OwnerEquitySection: () => null }));
/* R-2095: the transfer / other-income sections have their own tests (own-transfer-section-r2095). */
vi.mock("@/components/features/banking/other-income-section", () => ({ OtherIncomeSection: () => null }));
vi.mock("@/components/features/banking/own-transfer-section", () => ({ OwnTransferSection: () => null }));
vi.mock("@/components/features/banking/incentive-from-bank-section", () => ({ IncentiveFromBankSection: () => null }));
/* Money in with no advance to return → the real section renders nothing. */
vi.mock("@/components/features/banking/employee-advance-bank-section", () => ({ EmployeeAdvanceBankSection: () => null }));
vi.mock("@/components/features/banking/emi-repayment-section", () => ({
  EmiRepaymentSection: () => <section aria-label="EMI form">EMI</section>,
}));
vi.mock("@/components/features/banking/debit-pay-for-section", async () => {
  const R = await import("react");
  return {
    DebitPayForSection: ({ onVendorChange }: { onVendorChange?: (f: unknown) => void }) => {
      R.useEffect(() => { onVendorChange?.(state.focus); }, [onVendorChange]);
      return <section aria-label="Paying a vendor">Vendor form</section>;
    },
  };
});

import { ReconcileTransactionDialog } from "./reconcile-transaction-dialog";

const moneyIn = {
  id: "c1", bank_account_id: "b1", txn_date: "2026-10-20", description: "NEFT CR ACME TRADERS PVT LTD",
  debit: 0, credit: 59000, reference: null, category: null,
} as unknown as BankTransactionRow;
const moneyOut = {
  id: "d1", bank_account_id: "b1", txn_date: "2026-10-21", description: "UPI 9876@okhdfc",
  debit: 500, credit: 0, reference: null, category: null,
} as unknown as BankTransactionRow;

afterEach(cleanup);
beforeEach(() => { state.suggestions = []; state.customers = []; });

describe("R-2095: money in → Other / manual — interest has one home", () => {
  it("the manual box does not offer interest as a no-entry case; it points to the income box", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={moneyIn} />);
    fireEvent.click(screen.getByRole("radio", { name: /Other \/ manual/ }));
    const box = screen.getByText(/None of these match\?/).parentElement!;
    expect(box.textContent).not.toMatch(/bank charges, interest/);
    expect(box.textContent).toMatch(/Interest .* above/);
    expect(box.textContent).toMatch(/failed \/ reversed/);
  });

  it("money out keeps its own wording (bank charges)", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={moneyOut} />);
    fireEvent.click(screen.getByRole("radio", { name: /Bank charge \/ other/ }));
    expect(screen.getByText(/None of these match\?/).parentElement!.textContent).toMatch(/bank charges/);
  });
});
