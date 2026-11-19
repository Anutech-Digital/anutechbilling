// @vitest-environment jsdom
/* R-2935 (staging 18 Nov 2026, Excel HDFC 4523): the money-out line "FD REDEEM TAX - 50301205948354/1"
   (−₹801) is the TDS the bank cut on FD interest. The Reconcile sheet opens it on Tax → "TDS cut by
   bank" (TDS receivable), with that form's save in the footer — never the TDS challan / an expense.
   The form itself is tested in interest-tds-r2935.test.tsx; mocks follow reconcile-sheet-footer-r2354. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { BankTransactionRow } from "@/lib/queries/bank";

const state = vi.hoisted(() => ({
  focus: null as unknown,
  suggestions: [] as unknown[],
  customers: [] as unknown[],
  bookExpense: vi.fn(),
  reconcile: vi.fn(),
  bookAdvance: vi.fn(),
  transferPay: vi.fn(),
  otherIncomePay: vi.fn(),
  loanReceiptPay: vi.fn(),
  razorpayPay: vi.fn(),
}));
const { mutation } = vi.hoisted(() => ({ mutation: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }) }));

/* R-2025: no known payers, our own name (the payer warning / known-payer guess). */
vi.mock("@/lib/queries/customer-payers", () => ({
  usePayerMemory: () => ({ payers: [], ownNames: [] }),
  useSetBankLinePayer: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
/* R-2325: no suggested expense is reconciled elsewhere here (that read is tested in reconcile-suggestions-reconciled-r2325). */
vi.mock("@/lib/banking/reconciled-suggestions", async (orig) => ({
  ...(await orig<typeof import("@/lib/banking/reconciled-suggestions")>()),
  useReconciledExpenseIds: () => ({ data: new Set<string>(), isLoading: false }),
}));
/* R-2361: "Mark reconciled manually" opens a confirm that needs a reason (manual-reconcile-dialog.test.tsx). */
const r2361 = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("@/lib/banking/manual-reconcile", async (orig) => ({
  ...(await orig<typeof import("@/lib/banking/manual-reconcile")>()),
  useReconcileManually: () => ({ mutateAsync: r2361.save, isPending: false }),
  useReversalCandidates: () => ({ data: [], isLoading: false }),
}));
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
vi.mock("@/components/features/banking/credit-line-section", () => ({ CreditLineSection: () => null }));   // R-2374
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
vi.mock("@/components/features/banking/incentive-from-bank-section", () => ({ IncentiveFromBankSection: () => null }));
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
vi.mock("@/components/features/banking/other-income-section", () => ({ OtherIncomeSection: () => null }));
vi.mock("@/components/features/banking/own-transfer-section", () => ({ OwnTransferSection: () => null }));
vi.mock("@/components/features/banking/loan-given-receipt-section", () => ({ LoanGivenReceiptSection: () => null }));
vi.mock("@/components/features/banking/razorpay-settlement-section", () => ({ RazorpaySettlementSection: () => null }));
const r2935 = vi.hoisted(() => ({ book: vi.fn(), rows: [] as unknown[] }));
vi.mock("@/lib/queries/bank-other-income", () => ({
  useInterestWithoutTds: () => ({ data: r2935.rows, isLoading: false, isError: false }),
  useBookInterestTds: () => ({ mutateAsync: r2935.book, isPending: false }),
}));

import { ReconcileTransactionDialog } from "./reconcile-transaction-dialog";

const taxLine = {
  id: "tx", bank_account_id: "b1", txn_date: "2025-11-21", description: "FD REDEEM TAX - 50301205948354/1",
  debit: 801, credit: 0, reference: null, category: null,
} as unknown as BankTransactionRow;
const interest = { id: "i1", income_date: "2025-11-21", amount: 8014, description: "Interest on FD", source: "fd", fd_name: "HDFC FD 50301205948354" };

afterEach(cleanup);
beforeEach(() => {
  state.focus = null; state.suggestions = []; state.customers = [];
  r2935.rows = []; r2935.book.mockReset().mockResolvedValue({});
});

describe("R-2935 Reconcile sheet — the bank's TDS line on FD interest", () => {
  it("owner's line opens on Tax → TDS cut by bank; the footer books ₹801 as TDS receivable against the ₹8,014 interest", async () => {
    r2935.rows = [interest];
    const onOpenChange = vi.fn();
    render(<ReconcileTransactionDialog open onOpenChange={onOpenChange} transaction={taxLine} />);
    expect(screen.getByRole("button", { name: "TDS cut by bank" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "TDS" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByText(/a payment to the government, not an expense/)).toBeNull();
    const footer = screen.getByTestId("reconcile-footer");
    const save = await within(footer).findByRole("button", { name: "Book ₹801 as TDS receivable" }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(r2935.book).toHaveBeenCalledWith({ transactionId: "tx", otherIncomeId: "i1" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("interest not booked yet → the footer save is disabled and says to book the interest line first", async () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={taxLine} />);
    const footer = screen.getByTestId("reconcile-footer");
    const save = await within(footer).findByRole("button", { name: "Book ₹801 as TDS receivable" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(within(footer).getByText(/Book the interest line first/)).toBeTruthy();
    fireEvent.click(save);
    expect(r2935.book).not.toHaveBeenCalled();
  });

  it("picking the TDS challan instead still gives the challan save (unchanged)", async () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={taxLine} />);
    fireEvent.click(screen.getByRole("button", { name: "TDS" }));
    const footer = screen.getByTestId("reconcile-footer");
    expect(await within(footer).findByRole("button", { name: "Book ₹801 as TDS paid" })).toBeTruthy();
  });

  it("a real TDS challan line is NOT taken for the bank's TDS", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={{ ...taxLine, description: "ITNS 281 TDS PAYMENT CIN 4455" } as BankTransactionRow} />);
    expect(screen.getByRole("button", { name: "TDS" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "TDS cut by bank" }).getAttribute("aria-pressed")).toBe("false");
  });
});
