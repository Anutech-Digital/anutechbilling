// @vitest-environment jsdom
/* R-2685 — a 5,230-line bank account (staging Excel HDFC 4523) froze Chrome. The page draws one window
   of lines (100, "Load more"), only the layout on screen (table ≥ 1024 px, cards below), and memoised
   rows; the totals and the search still cover EVERY line, not just the ones drawn. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { bigBankAccount } from "@/lib/banking/__fixtures__/big-bank-account";
import { filterTotals } from "@/lib/banking/bank-filters";
import type { BankAccountRow } from "@/lib/queries/bank";

const state = vi.hoisted(() => ({ account: null as unknown, txns: [] as unknown[] }));
const { noData, mutation } = vi.hoisted(() => ({ noData: () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
  mutation: () => ({ mutate: vi.fn(), isPending: false, isSuccess: false, data: undefined, reset: vi.fn() }) }));

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "acct-4523" }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "owner" } }) }));
vi.mock("@/lib/queries/bank", async (orig) => ({
  ...(await orig<object>()),
  useBankAccount: () => ({ data: state.account, isLoading: false, isError: false, refetch: vi.fn() }),
  useBankTransactions: () => ({ data: state.txns, isLoading: false, isError: false, refetch: vi.fn() }),
  useBankOpeningHistory: noData,
  useReconcileTransaction: mutation,
  useAutoReconcile: mutation,
  useOpenInvoicesForCreditMatch: noData,
  useBankImportHistory: noData,
}));
vi.mock("@/lib/queries/bank-credit-pay-for", async (orig) => ({
  ...(await orig<object>()),
  useBankAdvancePaymentIds: noData, useBankSplitLinePayments: noData, useOldOneOffBookings: noData,
}));
vi.mock("@/lib/queries/customers", async (orig) => ({ ...(await orig<object>()), useCustomers: noData }));
vi.mock("@/lib/queries/customer-payers", async (orig) => ({ ...(await orig<object>()), usePayerMemory: () => ({ payers: [], ownNames: [] }) }));
vi.mock("@/lib/queries/vendors", async (orig) => ({ ...(await orig<object>()), useVendors: noData }));
vi.mock("@/lib/queries/txn-category-rules", async (orig) => ({ ...(await orig<object>()), useTxnCategoryRules: noData }));
vi.mock("@/lib/queries/bank-debit-pay-for", async (orig) => ({ ...(await orig<object>()), useVendorNarrationAliases: noData }));
vi.mock("@/lib/queries/bank-aa", async (orig) => ({ ...(await orig<object>()), useBankAaConnection: noData, useFetchAaNow: mutation }));
vi.mock("@/lib/banking/manual-reconcile", async (orig) => ({ ...(await orig<object>()), useOwnerBookingNotes: noData }));
vi.mock("@/lib/banking/line-booking", async (orig) => ({ ...(await orig<object>()), useLineBookings: noData }));
vi.mock("@/components/features/banking/use-zoho-match-count", async (orig) => ({ ...(await orig<object>()), useZohoMatchSet: noData }));
const salaryRenders = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/components/features/banking/salary-lines-dialog", async (orig) => ({
  ...(await orig<object>()), SalaryLinesDialog: () => { salaryRenders.n += 1; return null; },
}));
vi.mock("@/components/features/banking/import-statement-dialog", () => ({ ImportStatementDialog: () => null }));
vi.mock("@/components/features/banking/statement-check-card", () => ({ StatementCheckCard: () => null }));
vi.mock("@/components/features/banking/bank-imports-section", () => ({ BankImportsSection: () => null }));
vi.mock("@/components/features/banking/reconcile-transaction-dialog", () => ({ ReconcileTransactionDialog: () => null }));
vi.mock("@/components/features/banking/unreconcile-dialog", () => ({ UnreconcileDialog: () => null }));
vi.mock("@/components/features/banking/connect-aa-dialog", () => ({ ConnectAaDialog: () => null }));
vi.mock("@/components/features/banking/old-one-off-bookings", () => ({ RelinkOneOffDialog: () => null }));
vi.mock("@/components/features/banking/bulk-expense-sheet", () => ({ BulkExpenseButton: () => null }));
vi.mock("@/components/features/banking/razorpay-settlement-batch", () => ({ RazorpaySettlementBatchButton: () => null }));

import AccountPage from "./page";

const big = bigBankAccount();
const account: BankAccountRow = {
  id: big.accountId, tenant_id: "t-1", name: "HDFC 4523", bank_name: "HDFC Bank", account_number_last4: "4523", ifsc: "HDFC0001234",
  account_type: "current", opening_balance: 2_500_000, opening_balance_date: "2025-04-01", is_active: true,
  notes: null, created_at: "", updated_at: "",
};

/** A laptop-width window: matchMedia says ≥ 1024 px. */
function wideScreen(wide: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (q: string) => ({ matches: wide, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn(), onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() }),
  });
}
const drawnRows = () => document.querySelectorAll("tr[data-txn-id]").length;
const drawnCards = () => document.querySelectorAll("li[data-txn-id]").length;

beforeEach(() => {
  window.history.replaceState(null, "", `/accounting/banking/${big.accountId}`);
  state.account = account;
  state.txns = big.lines;
  salaryRenders.n = 0;
});
afterEach(() => {
  cleanup();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe("R-2685 big bank account — a window of lines, totals and search over all of them", () => {
  it("draws 100 of the 5,230 lines, as table rows only on a wide screen", () => {
    wideScreen(true);
    render(<AccountPage />);
    expect(drawnRows()).toBe(100);
    expect(drawnCards()).toBe(0);
    expect(screen.getByText("Showing 100 of 5,230 lines")).toBeTruthy();
  });

  it("a narrow screen draws the cards only", () => {
    wideScreen(false);
    render(<AccountPage />);
    expect(drawnCards()).toBe(100);
    expect(drawnRows()).toBe(0);
  });

  it("the totals cover every line, not just the 100 drawn", () => {
    wideScreen(true);
    render(<AccountPage />);
    const all = filterTotals(big.lines);
    const bar = screen.getByText("5,230").closest("div") as HTMLElement;
    expect(bar.textContent).toContain("5,230 lines");
    expect(bar.textContent).toContain(`In ₹${all.moneyIn.toLocaleString("en-IN")}`);
  });

  it("search finds a line far below the first window", async () => {
    wideScreen(true);
    const oldest = big.lines[0];   // the list is newest first — the oldest line is not drawn
    render(<AccountPage />);
    expect(document.querySelector(`tr[data-txn-id="${oldest.id}"]`)).toBeNull();
    cleanup();
    window.history.replaceState(null, "", `/accounting/banking/${big.accountId}?q=${encodeURIComponent(oldest.description.slice(0, 40))}`);
    await act(async () => { render(<AccountPage />); });
    expect(document.querySelector(`tr[data-txn-id="${oldest.id}"]`)).not.toBeNull();
  });

  it("the Salary lines sheet is not mounted (or worked out) until it is opened", () => {
    wideScreen(true);
    render(<AccountPage />);
    expect(salaryRenders.n).toBe(0);
    act(() => { screen.getByRole("button", { name: /^Salary lines \(/ }).click(); });
    expect(salaryRenders.n).toBeGreaterThan(0);
  });
});
