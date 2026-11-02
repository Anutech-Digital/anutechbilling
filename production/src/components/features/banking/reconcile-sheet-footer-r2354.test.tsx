// @vitest-environment jsdom
/* R-2354 (last of R-2348 / R-2008) — the Reconcile SHEET: Own transfer, Other income (money in), a
   receipt on a loan given and a Razorpay settlement save from the sticky footer. On Own transfer and
   money-in Other the section's save is the ONE primary and "Mark reconciled manually" is a secondary
   button in its box (before: two primaries). The sections themselves are tested with the real code in
   reconcile-footer-r2354.test.tsx; here stubs hand the footer their Save the way the real ones do.
   Mocks follow reconcile-who-tiles-r2006.test.tsx. */
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
/* R-2354: stubs that hand the footer their Save like the real sections (Razorpay once fetched). */
vi.mock("@/components/features/banking/other-income-section", async () => {
  const { useFooterSaveReport } = await import("./reconcile-who-tiles");
  return {
    OtherIncomeSection: ({ onFooterSave }: { onFooterSave?: Parameters<typeof useFooterSaveReport>[0] }) => {
      useFooterSaveReport(onFooterSave, { label: "Book ₹11,800 as interest received", onSave: state.otherIncomePay });
      return <section aria-label="Interest or other income" />;
    },
  };
});
vi.mock("@/components/features/banking/own-transfer-section", async () => {
  const { useFooterSaveReport } = await import("./reconcile-who-tiles");
  return {
    OwnTransferSection: ({ onFooterSave }: { onFooterSave?: Parameters<typeof useFooterSaveReport>[0] }) => {
      useFooterSaveReport(onFooterSave, { label: "Post ₹11,800 as transfer", onSave: state.transferPay });
      return <section aria-label="Transfer with another account" />;
    },
  };
});
vi.mock("@/components/features/banking/loan-given-receipt-section", async () => {
  const { useFooterSaveReport } = await import("./reconcile-who-tiles");
  return {
    LoanGivenReceiptSection: ({ onFooterSave }: { onFooterSave?: Parameters<typeof useFooterSaveReport>[0] }) => {
      useFooterSaveReport(onFooterSave, { label: "Reconcile as receipt 2", onSave: state.loanReceiptPay });
      return <section aria-label="Loan given receipt"><input type="radio" aria-label="Receipt 2 · Vinod Hem Raj" /></section>;
    },
  };
});
vi.mock("@/components/features/banking/razorpay-settlement-section", async () => {
  const R = await import("react");
  const { useFooterSaveReport } = await import("./reconcile-who-tiles");
  return {
    RazorpaySettlementSection: ({ onFooterSave }: { onFooterSave?: Parameters<typeof useFooterSaveReport>[0] }) => {
      const [open, setOpen] = R.useState(false);
      useFooterSaveReport(onFooterSave, open ? { label: "Reconcile settlement", onSave: state.razorpayPay } : null);
      return <section aria-label="Razorpay settlement"><button type="button" onClick={() => setOpen(true)}>Fetch settlement</button></section>;
    },
  };
});

import { ReconcileTransactionDialog } from "./reconcile-transaction-dialog";

const sharmaLine = {
  id: "t1", bank_account_id: "b1", txn_date: "2026-10-08", description: "IMPS SHARMA ASSOCIATES PS-2",
  debit: 11800, credit: 0, reference: null, category: null,
} as unknown as BankTransactionRow;
/* A primary button is the amber one (components/ui/button.tsx variant "primary"). */
const primaryButtons = () =>
  screen.getAllByRole("button").filter((b) => b.className.split(/\s+/).includes("bg-amber"));

afterEach(cleanup);
beforeEach(() => {
  state.focus = null;
  state.suggestions = [];
  state.customers = [];
  for (const fn of [state.bookExpense, state.reconcile, state.bookAdvance, state.transferPay, state.otherIncomePay,
    state.loanReceiptPay, state.razorpayPay]) fn.mockReset().mockResolvedValue({});
});

describe("R-2354 Reconcile sheet — Own transfer, Other income, Loan received, Razorpay save from the footer", () => {
  const credit = { ...sharmaLine, debit: 0, credit: 11800, description: "NEFT VINOD HEM RAJ" } as BankTransactionRow;
  const rzpLine = { ...sharmaLine, debit: 0, credit: 11800, description: "NEFT CR RAZORPAY PAYMENTS PVT LTD PAYMENT AGGREGATOR" } as BankTransactionRow;
  const parts = () => {
    const footer = screen.getByTestId("reconcile-footer");
    const body = screen.getByTestId("reconcile-scroll-body");
    const footerPrimaries = within(footer).getAllByRole("button").filter((b) => b.className.split(/\s+/).includes("bg-amber"));
    expect(footerPrimaries).toHaveLength(1);
    // exactly one primary on the whole sheet — the footer's
    expect(primaryButtons()).toEqual(footerPrimaries);
    return { footer, body, primary: footerPrimaries[0] as HTMLButtonElement };
  };

  it("Own transfer: 'Post ₹X as transfer' is the footer's one primary; Mark reconciled manually is secondary in the box", async () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={credit} />);
    fireEvent.click(screen.getByRole("radio", { name: /^Own transfer/ }));
    const { body, primary } = parts();
    expect(primary.textContent).toBe("Post ₹11,800 as transfer");
    const manual = within(body).getByRole("button", { name: "Mark reconciled manually" });
    expect(manual.className.split(/\s+/)).not.toContain("bg-amber");
    fireEvent.click(primary);
    expect(state.transferPay).toHaveBeenCalledTimes(1);
    /* R-2361: the manual button opens a confirm that needs a reason — one click saves nothing. */
    r2361.save.mockReset(); r2361.save.mockResolvedValue({});
    fireEvent.click(manual);
    expect(state.reconcile).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Reason (required)"), { target: { value: "Sweep from own savings account" } });
    fireEvent.click(screen.getByRole("button", { name: "Mark reconciled" }));
    await vi.waitFor(() => expect(r2361.save).toHaveBeenCalledWith(expect.objectContaining({ transactionId: "t1", reason: "Sweep from own savings account" })));
  });

  it("Other / manual (money in): 'Book ₹X as interest received' is the footer's one primary; manual is secondary", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={credit} />);
    fireEvent.click(screen.getByRole("radio", { name: /^Other \/ manual/ }));
    const { body, primary } = parts();
    expect(primary.textContent).toBe("Book ₹11,800 as interest received");
    expect(within(body).getByRole("button", { name: "Mark reconciled manually" })).toBeTruthy();
    fireEvent.click(primary);
    expect(state.otherIncomePay).toHaveBeenCalledTimes(1);
  });

  it("Tax refund keeps 'Mark reconciled manually' as its footer save (no section save there)", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={credit} />);
    fireEvent.click(screen.getByRole("radio", { name: /^Tax refund/ }));
    expect(parts().primary.textContent).toBe("Mark reconciled manually");
  });

  it("Loan / EMI (money in): the loan-given receipt owns the footer first; typing in Loan with a person moves it there and back", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={credit} />);
    fireEvent.click(screen.getByRole("radio", { name: /^Loan \/ EMI/ }));
    expect(parts().primary.textContent).toBe("Reconcile as receipt 2");
    fireEvent.change(screen.getByLabelText("Person's name (e.g. Julie Rawat)"), { target: { value: "Julie Rawat" } });
    expect(parts().primary.textContent).toMatch(/^Book ₹11,800 as /);
    fireEvent.click(screen.getByRole("radio", { name: "Receipt 2 · Vinod Hem Raj" }));
    const { primary } = parts();
    expect(primary.textContent).toBe("Reconcile as receipt 2");
    fireEvent.click(primary);
    expect(state.loanReceiptPay).toHaveBeenCalledTimes(1);
  });

  it("Razorpay settlement: once fetched, 'Reconcile settlement' is the footer's save; a tile's form takes the footer back", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={rzpLine} />);
    fireEvent.click(screen.getByRole("button", { name: "Fetch settlement" }));
    let { primary } = parts();
    expect(primary.textContent).toBe("Reconcile settlement");
    fireEvent.click(primary);
    expect(state.razorpayPay).toHaveBeenCalledTimes(1);
    // picking Own transfer → its save; clicking the Razorpay box again → the settlement
    fireEvent.click(screen.getByRole("radio", { name: /^Own transfer/ }));
    expect(parts().primary.textContent).toBe("Post ₹11,800 as transfer");
    fireEvent.click(screen.getByRole("region", { name: "Razorpay settlement" }));
    expect(parts().primary.textContent).toBe("Reconcile settlement");
    fireEvent.click(screen.getByRole("region", { name: "Transfer with another account" }));
    ({ primary } = parts());
    expect(primary.textContent).toBe("Post ₹11,800 as transfer");
  });
});
