// @vitest-environment jsdom
/* R-1917 — the money-out Reconcile sheet for a vendor's line has ONE way (R-1906 audit B8 + UI rule
   "one way per task, primary button = the right next step").
   Owner's example: Sharma Associates' ₹11,800 bill PS-2 is unpaid; the ₹11,800 Sharma line is opened.
     · the vendor section is the only open block and its Record payment the only primary button;
     · every other way (suggested matches, EMI, Book as expense, Combine, loan/advance, manual) sits
       behind "Not a payment to Sharma Associates?";
     · there, "Book as expense" for Sharma is refused with a sentence naming PS-2;
     · Combine no longer offers Sharma's own bill (it is paid in the vendor section).
   The vendor section itself is tested in debit-pay-for-section.test.tsx; it is a stub here that
   reports the vendor the way the real one does (onVendorChange). */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import type { VendorFocus } from "@/lib/banking/vendor-line-guard";
import type { VendorOpenItem } from "@/lib/banking/debit-pay-for";
import type { BankTransactionRow } from "@/lib/queries/bank";

const state = vi.hoisted(() => ({
  focus: null as unknown,
  bookExpense: vi.fn(),
  suggestions: [] as unknown[],
  expenses: [] as unknown[],
}));
const { mutation } = vi.hoisted(() => ({ mutation: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }) }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/queries/bank", () => ({
  useSuggestMatches: () => ({ data: state.suggestions, isLoading: false }),
  useReconcileTransaction: mutation,
  useReconcileExpensesToBankTxn: mutation,
  useBookTxnAsExpense: () => ({ mutateAsync: state.bookExpense, isPending: false }),
  useBookBankCredit: mutation,
  useBookBankAdvance: mutation,
  useBookBankTxnAsStatutory: mutation,
  useBookBankTxnAsCommission: mutation,
  useReconcileSalaryAdvanceSplit: mutation,
}));
vi.mock("@/lib/queries/expenses", () => ({
  EXPENSE_CATEGORIES: ["Professional Services", "Bank Charges", "Salaries", "Other"],
  useUnreconciledExpenses: () => ({ data: state.expenses }),
  suggestCategory: () => null,
}));
vi.mock("@/lib/queries/txn-category-rules", () => ({ useTxnCategoryRules: () => ({ data: [] }) }));
vi.mock("@/lib/queries/payroll", () => ({ useUnreconciledSalaries: () => ({ data: [] }), useEmployees: () => ({ data: [] }) }));
vi.mock("@/lib/queries/customers", () => ({ useCustomers: () => ({ data: [] }) }));
vi.mock("@/lib/queries/tax-payments", () => ({ useBookBankTxnAsTax: mutation }));
vi.mock("@/lib/queries/salary-from-bank", () => ({ useBookSalaryLines: mutation }));
vi.mock("@/lib/queries/prepaid-advances", () => ({ usePrepaidAdvances: () => ({ data: [] }) }));
vi.mock("@/lib/queries/referral-commissions", () => ({ useReferralCommissions: () => ({ data: [] }) }));
vi.mock("@/lib/compliance/profile", () => ({ useComplianceProfile: () => ({ data: { businessType: "pvt_ltd" } }) }));
vi.mock("@/components/features/customers/add-customer-form", () => ({ AddCustomerForm: () => null }));
vi.mock("@/components/features/banking/project-payment-section", () => ({ ProjectPaymentSection: () => null }));
vi.mock("@/components/features/banking/credit-pay-for-section", () => ({ CreditPayForSection: () => null }));
vi.mock("@/components/features/banking/owner-equity-section", () => ({ OwnerEquitySection: () => null }));
vi.mock("@/components/features/banking/incentive-from-bank-section", () => ({ IncentiveFromBankSection: () => null }));
vi.mock("@/components/features/banking/employee-advance-bank-section", () => ({ EmployeeAdvanceBankSection: () => null }));
vi.mock("@/components/features/banking/emi-repayment-section", async () => {
  const { Button } = await import("@/components/ui/button");
  return { EmiRepaymentSection: () => <Button variant="primary">Book as EMI</Button> };
});
vi.mock("@/components/features/banking/debit-pay-for-section", async () => {
  const R = await import("react");
  const { Button } = await import("@/components/ui/button");
  return {
    DebitPayForSection: ({ onVendorChange }: { onVendorChange?: (f: unknown) => void }) => {
      R.useEffect(() => { onVendorChange?.(state.focus); }, [onVendorChange]);
      const f = state.focus as VendorFocus | null;
      return (
        <section aria-label="Paying a vendor">
          {f && <Button variant="primary">Record payment ₹11,800 to {f.vendorName} &amp; reconcile</Button>}
        </section>
      );
    },
  };
});

import { ReconcileTransactionDialog } from "./reconcile-transaction-dialog";

const PS2: VendorOpenItem = {
  source: "expense", doc_id: "E2", bill_no: "PS-2", doc_date: "2026-09-10", due_date: null, category: "Professional Services",
  total: 11800, amount_due: 11800, gst: 1800, tds_base: 10000, tds_amount: 0, tds_section: null, can_part: false, in_run: null,
};
const sharmaLine = {
  id: "t1", bank_account_id: "b1", txn_date: "2026-10-08", description: "IMPS SHARMA ASSOCIATES PS-2",
  debit: 11800, credit: 0, reference: null, category: null,
} as unknown as BankTransactionRow;

/* A primary button is the amber one (components/ui/button.tsx variant "primary"). */
const primaryButtons = () =>
  screen.getAllByRole("button").filter((b) => b.className.split(/\s+/).includes("bg-amber"));

afterEach(cleanup);
beforeEach(() => {
  state.bookExpense.mockReset();
  state.focus = { vendorId: "v1", vendorName: "Sharma Associates", openItems: [PS2] } satisfies VendorFocus;
  state.suggestions = [{ match_type: "expense", match_id: "E2", match_label: "Sharma Associates · PS-2", match_amount: 11800, match_date: "2026-09-10", match_confidence: "exact" }];
  state.expenses = [
    { id: "E2", category: "Professional Services", vendor_id: "v1", vendor_name: "Sharma Associates", expense_date: "2026-09-10", description: null, amount: 11800 },
    { id: "E9", category: "Rent", vendor_id: "v7", vendor_name: "Kapoor Estates", expense_date: "2026-09-01", description: null, amount: 30000 },
  ];
});

describe("R-1917 Reconcile sheet — one way for a vendor's money-out line", () => {
  it("Sharma line: the vendor section's Record payment is the ONLY primary button; the rest is folded", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={sharmaLine} />);
    const primaries = primaryButtons();
    expect(primaries.map((b) => b.textContent)).toEqual(["Record payment ₹11,800 to Sharma Associates & reconcile"]);
    expect(screen.queryByText("Suggested matches")).toBeNull();
    expect(screen.queryByText(/Book as a new expense|Looks like a/)).toBeNull();
    expect(screen.queryByText("Combine multiple expenses")).toBeNull();
    expect(screen.queryByText("Mark reconciled manually")).toBeNull();
    const fold = screen.getByRole("button", { name: /Not a payment to Sharma Associates\? Other ways to book this line/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
  });

  it("B8: opened from the fold, Book as expense for Sharma is refused with a sentence naming PS-2", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={sharmaLine} />);
    fireEvent.click(screen.getByRole("button", { name: /Not a payment to Sharma Associates\?/ }));
    expect((screen.getByLabelText("Vendor / payee (optional)") as HTMLInputElement).value).toBe("Sharma Associates");
    fireEvent.change(screen.getByLabelText("Expense category"), { target: { value: "Professional Services" } });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Sharma Associates has an open bill PS-2 for ₹11,800 — pay it with Record payment above");
    const book = screen.getByRole("button", { name: /Book ₹11,800 as Professional Services/ }) as HTMLButtonElement;
    expect(book.disabled).toBe(true);
    fireEvent.click(book);
    expect(state.bookExpense).not.toHaveBeenCalled();
    // "Go to Record payment" closes the fold again.
    fireEvent.click(within(alert).getByRole("button", { name: "Go to Record payment" }));
    expect(screen.queryByLabelText("Expense category")).toBeNull();
  });

  it("the expense is for someone else (payee changed) → it books", async () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={sharmaLine} />);
    fireEvent.click(screen.getByRole("button", { name: /Not a payment to Sharma Associates\?/ }));
    fireEvent.change(screen.getByLabelText("Expense category"), { target: { value: "Other" } });
    fireEvent.change(screen.getByLabelText("Vendor / payee (optional)"), { target: { value: "Gupta Printers" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Book ₹11,800 as Other/ }));
    expect(state.bookExpense).toHaveBeenCalledWith(expect.objectContaining({ transactionId: "t1", vendor: "Gupta Printers", category: "Other" }));
  });

  it("Combine multiple expenses (in the fold) leaves out Sharma's own bill — it is paid in the vendor section", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={sharmaLine} />);
    fireEvent.click(screen.getByRole("button", { name: /Not a payment to Sharma Associates\?/ }));
    fireEvent.click(screen.getByRole("button", { name: "Combine multiple expenses" }));
    expect(screen.getByText("Rent · Kapoor Estates")).toBeTruthy();
    expect(screen.queryByText("Professional Services · Sharma Associates")).toBeNull();
  });

  it("no vendor known: the sheet is as before — suggestions and the expense form are open", () => {
    state.focus = null;
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={{ ...sharmaLine, description: "UPI 9876@okhdfc" } as BankTransactionRow} />);
    expect(screen.getByText("Suggested matches")).toBeTruthy();
    expect(screen.getByLabelText("Expense category")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Other ways to book this line/ })).toBeNull();
  });
});
