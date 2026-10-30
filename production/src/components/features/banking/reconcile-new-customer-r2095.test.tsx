// @vitest-environment jsdom
/* R-2095 (30 Oct 2026, September reconcile on staging): "Add customer" from the reconcile sheet
   sometimes left the customer box empty — the new id was picked before the customers list had
   refetched, so the box had no such option. The sheet now refetches the list FIRST, then picks. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { BankTransactionRow } from "@/lib/queries/bank";

const state = vi.hoisted(() => ({
  focus: null as unknown,
  suggestions: [] as unknown[],
  customers: [] as unknown[],
  bookExpense: vi.fn(),
  reconcile: vi.fn(),
  bookAdvance: vi.fn(),
  refetch: vi.fn(),
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
vi.mock("@/lib/queries/customers", () => ({ useCustomers: () => ({ data: state.customers, refetch: state.refetch }) }));
vi.mock("@/lib/queries/tax-payments", () => ({ useBookBankTxnAsTax: mutation }));
vi.mock("@/lib/queries/salary-from-bank", () => ({ useBookSalaryLines: mutation }));
vi.mock("@/lib/queries/prepaid-advances", () => ({ usePrepaidAdvances: () => ({ data: [] }) }));
vi.mock("@/lib/queries/referral-commissions", () => ({ useReferralCommissions: () => ({ data: [] }) }));
vi.mock("@/lib/compliance/profile", () => ({ useComplianceProfile: () => ({ data: { businessType: "pvt_ltd" } }) }));
vi.mock("@/components/features/customers/add-customer-form", () => ({
  AddCustomerForm: ({ onCreated }: { onCreated?: (id: string) => void }) => <button type="button" onClick={() => onCreated?.("cust-new")}>fake create</button>,
}));
vi.mock("@/components/features/banking/project-payment-section", () => ({ ProjectPaymentSection: () => null }));
/* R-2007's Suggestion card has its own test (reconcile-suggestion-r2007.test.tsx); none here. */
vi.mock("@/components/features/banking/reconcile-suggestion-card", () => ({
  useReconcileSuggestion: () => ({ suggestion: null, accept: async () => false, accepting: false }),
  SuggestionCard: () => null,
  logSuggestion: () => {},
}));
vi.mock("@/components/features/banking/credit-pay-for-section", () => ({
  CreditPayForSection: ({ pickedCustomerId, customers }: { pickedCustomerId?: string | null; customers: Array<{ id: string }> }) => (
    <section aria-label="Customer payment form">picked={pickedCustomerId ?? "none"} inList={String(customers.some((c) => c.id === pickedCustomerId))}</section>
  ),
}));
vi.mock("@/components/features/banking/owner-equity-section", () => ({ OwnerEquitySection: () => null }));
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
  id: "c1", bank_account_id: "b1", txn_date: "2026-09-19", description: "NEFT CR NEW BUYER PVT LTD",
  debit: 0, credit: 91350, reference: null, category: null,
} as unknown as BankTransactionRow;

afterEach(cleanup);
beforeEach(() => {
  state.customers = [{ id: "cust-old", name: "Old Co" }];
  state.refetch.mockReset();
});

describe("R-2095 a customer created from the reconcile sheet is picked once the list has it", () => {
  it("refetches the customers list before picking the new customer", async () => {
    state.refetch.mockImplementation(async () => { state.customers = [...state.customers, { id: "cust-new", name: "New Buyer" }]; });
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={moneyIn} />);
    fireEvent.click(screen.getByRole("radio", { name: /Customer/ }));
    fireEvent.click(screen.getByText("fake create"));
    await waitFor(() => expect(screen.getByRole("region", { name: "Customer payment form" }).textContent).toContain("picked=cust-new"));
    expect(state.refetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("region", { name: "Customer payment form" }).textContent).toContain("inList=true");
  });
});
