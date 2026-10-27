// @vitest-environment jsdom
/* R-2006 — the Reconcile sheet: bank line → "Who is this money for?" tiles → ONLY the chosen
   tile's section (with "← Change") → "Suggested matches" only when there is one → a footer that
   always shows the amount and, for the chosen form, its Save.
   Owner's examples (Pardeep, 27 Oct): an SCN HDFC money-in line from a customer; a money-out line
   to a vendor; a ₹500 bank charge; a transfer to the owner's other account. */
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
vi.mock("@/components/features/banking/credit-pay-for-section", () => ({
  CreditPayForSection: () => <section aria-label="Customer payment form">Who paid?</section>,
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
  id: "c1", bank_account_id: "b1", txn_date: "2026-10-20", description: "NEFT CR ACME TRADERS PVT LTD",
  debit: 0, credit: 59000, reference: null, category: null,
} as unknown as BankTransactionRow;
const moneyOut = {
  id: "d1", bank_account_id: "b1", txn_date: "2026-10-21", description: "UPI 9876@okhdfc",
  debit: 500, credit: 0, reference: null, category: null,
} as unknown as BankTransactionRow;

const tiles = () => within(screen.getByRole("radiogroup", { name: "Who is this money for?" })).getAllByRole("radio");
const footer = () => screen.getByTestId("reconcile-footer");

afterEach(cleanup);
beforeEach(() => {
  state.focus = null;
  state.suggestions = [];
  state.customers = [];
  state.bookExpense.mockReset();
  state.reconcile.mockReset();
  state.bookAdvance.mockReset();
});

describe("R-2006 Reconcile sheet — 'Who is this money for?' tiles", () => {
  it("money in shows the money-in tiles; money out the money-out tiles", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={moneyIn} />);
    expect(tiles().map((t) => within(t).getByText(/./, { selector: "span.truncate" }).textContent)).toEqual([
      "Customer", "Owner", "Loan / EMI", "Employee return", "Own transfer", "Tax refund", "Other / manual",
    ]);
    cleanup();
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={moneyOut} />);
    expect(tiles().map((t) => within(t).getByText(/./, { selector: "span.truncate" }).textContent)).toEqual([
      "Vendor", "Employee / salary", "Owner", "Loan / EMI", "Tax / GST / TDS", "Own transfer", "Bank charge / other",
    ]);
    expect(tiles().every((t) => t.getAttribute("aria-checked") === "false")).toBe(true);
  });

  it("a tile opens ONLY its section; ← Change brings the tiles back", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={moneyOut} />);
    // Before a pick no form is open.
    expect(screen.queryByLabelText("Expense category")).toBeNull();
    expect(screen.queryByRole("region", { name: "EMI form" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /Loan \/ EMI/ }));
    expect(screen.getByRole("region", { name: "EMI form" })).toBeTruthy();
    expect(screen.getByLabelText("Person's name (e.g. Julie Rawat)")).toBeTruthy();
    expect(screen.queryByLabelText("Expense category")).toBeNull();
    expect(screen.queryByText(/Statutory \/ tax payment/)).toBeNull();
    expect(screen.queryByRole("region", { name: "Paying a vendor" })).toBeNull(); // mounted but hidden
    expect(screen.queryByRole("radiogroup")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change who this money is for" }));
    expect(tiles()).toHaveLength(7);
    expect(screen.queryByRole("region", { name: "EMI form" })).toBeNull();
  });

  it("footer: the chosen form's Save and the amount check; disabled with a reason until ready", async () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={moneyOut} />);
    expect(footer().textContent).toContain("pick who this money is for");
    fireEvent.click(screen.getByRole("radio", { name: /Bank charge \/ other/ }));
    const save = within(footer()).getByRole("button", { name: "Book ₹500 expense" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(footer().textContent).toContain("Choose a category.");
    fireEvent.change(screen.getByLabelText("Expense category"), { target: { value: "Bank Charges" } });
    expect(footer().textContent).toContain("Bank ₹500 = ₹500 ✓");
    fireEvent.click(within(footer()).getByRole("button", { name: "Book ₹500 as Bank Charges" }));
    expect(state.bookExpense).toHaveBeenCalledWith(expect.objectContaining({ transactionId: "d1", category: "Bank Charges" }));
  });

  it("Own transfer: the footer's Save marks the line reconciled manually", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={moneyIn} />);
    fireEvent.click(screen.getByRole("radio", { name: /Own transfer/ }));
    fireEvent.click(within(footer()).getByRole("button", { name: "Mark reconciled manually" }));
    expect(state.reconcile).toHaveBeenCalledWith(expect.objectContaining({ transactionId: "c1", matchedToType: "manual" }));
  });

  it("no match → one small line, no 'Suggested matches' box; a match → the list shows", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={moneyOut} />);
    expect(screen.getByText(/No close matches in your books/)).toBeTruthy();
    expect(screen.queryByText("Suggested matches")).toBeNull();
    cleanup();
    state.suggestions = [{ match_type: "expense", match_id: "E1", match_label: "Bank charges Oct", match_amount: 500, match_date: "2026-10-21", match_confidence: "exact" }];
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={moneyOut} />);
    expect(screen.getByText("Suggested matches")).toBeTruthy();
    expect(screen.queryByText(/No close matches/)).toBeNull();
  });

  it("keyboard: tiles are one tab stop; arrows move between them; Enter picks", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={moneyOut} />);
    const t = tiles();
    expect(t.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    t[0].focus();
    fireEvent.keyDown(t[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(t[1]);
    fireEvent.keyDown(t[1], { key: "ArrowLeft" });
    fireEvent.keyDown(t[0], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(t[6]);
    fireEvent.click(t[6]);
    expect(screen.getByLabelText("Expense category")).toBeTruthy();
  });

  it("a guessed vendor opens the Vendor tile by itself (money out)", () => {
    state.focus = { vendorId: "v1", vendorName: "Sharma Associates", openItems: [] };
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={moneyOut} />);
    expect(screen.getByText("Vendor", { selector: "span.text-ink" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Paying a vendor" })).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("a guessed customer opens the Customer tile by itself (money in)", () => {
    state.customers = [{ id: "cu1", name: "Acme Traders" }, { id: "cu2", name: "Bharat Steel" }];
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={moneyIn} />);
    expect(screen.getByRole("region", { name: "Customer payment form" })).toBeTruthy();
    expect(screen.getByText("Customer", { selector: "span.text-ink" })).toBeTruthy();
  });

  it("no customer guessed → tiles, nothing picked", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={moneyIn} />);
    expect(screen.queryByRole("region", { name: "Customer payment form" })).toBeNull();
    expect(tiles()).toHaveLength(7);
  });

  it("a tile whose section has nothing for this line says so in one line", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={moneyIn} />);
    fireEvent.click(screen.getByRole("radio", { name: /Employee return/ }));
    expect(screen.getByText(/Nothing to book here for this line/)).toBeTruthy();
  });

  it("a government challan opens the Tax tile; picking Vendor yourself still shows the vendor form", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={{ ...moneyOut, description: "01026130346651/ESIC" } as BankTransactionRow} />);
    expect(screen.getByText("Tax / GST / TDS", { selector: "span.text-ink" })).toBeTruthy();
    expect(within(footer()).getByRole("button", { name: "Book ₹500 as ESI paid" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change who this money is for" }));
    fireEvent.click(screen.getByRole("radio", { name: /^Vendor/ }));
    expect(screen.getByRole("region", { name: "Paying a vendor" })).toBeTruthy();
  });

  it("Loan tile: the footer Save waits for the person's name, then books the loan", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={moneyIn} />);
    fireEvent.click(screen.getByRole("radio", { name: /Loan \/ EMI/ }));
    expect(footer().textContent).toContain("Enter the person's name.");
    fireEvent.change(screen.getByLabelText("Person's name (e.g. Julie Rawat)"), { target: { value: "Julie Rawat" } });
    fireEvent.click(within(footer()).getByRole("button", { name: /Book ₹59,000 as/ }));
    expect(state.bookAdvance).toHaveBeenCalledWith(expect.objectContaining({ transactionId: "c1", counterparty: "Julie Rawat" }));
  });
});
