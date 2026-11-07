// @vitest-environment jsdom
/* R-2378 — OD / loan audit, 2 Nov: a bank line booked through Loan / EMI → "Loan / advance with a person"
   (book_bank_advance) is stored as matched_to_type 'manual'. On the account page it must read as its booking
   ("Loan received") with the party linking to where the booking lives — never the bare "Reconciled" a real
   "Mark reconciled manually" line keeps. Harness from running-balance-r2400.test.tsx. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import type { BankAccountRow, BankTransactionRow } from "@/lib/queries/bank";
import type { LineBooking } from "@/lib/banking/line-booking";

const state = vi.hoisted(() => ({
  account: null as unknown,
  txns: [] as unknown[],
  bookings: undefined as Map<string, LineBooking> | undefined,
}));
const { noData, mutation } = vi.hoisted(() => ({ noData: () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
  mutation: () => ({ mutate: vi.fn(), isPending: false, isSuccess: false, data: undefined, reset: vi.fn() }) }));

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "acc-1" }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "owner" } }) }));
vi.mock("@/lib/queries/bank", async (orig) => ({
  ...(await orig<object>()),
  useBankAccount: () => ({ data: state.account, isLoading: false, isError: false, refetch: vi.fn() }),
  useBankTransactions: () => ({ data: state.txns, isLoading: false, isError: false, refetch: vi.fn() }),
  useBankOpeningHistory: noData,   // R-2497: the opening-history note
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
vi.mock("@/lib/banking/line-booking", async (orig) => ({
  ...(await orig<object>()),
  useLineBookings: (_id: string, enabled: boolean) => ({ data: enabled ? state.bookings : undefined, isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock("@/components/features/banking/use-zoho-match-count", async (orig) => ({ ...(await orig<object>()), useZohoMatchSet: noData }));
vi.mock("@/components/features/banking/salary-lines-dialog", async (orig) => ({ ...(await orig<object>()), SalaryLinesDialog: () => null }));
vi.mock("@/components/features/banking/import-statement-dialog", () => ({ ImportStatementDialog: () => null }));
vi.mock("@/components/features/banking/statement-check-card", () => ({ StatementCheckCard: () => null }));
vi.mock("@/components/features/banking/bank-imports-section", () => ({ BankImportsSection: () => null }));
vi.mock("@/components/features/banking/reconcile-transaction-dialog", () => ({ ReconcileTransactionDialog: () => null }));
vi.mock("@/components/features/banking/unreconcile-dialog", () => ({ UnreconcileDialog: () => null }));
vi.mock("@/components/features/banking/connect-aa-dialog", () => ({ ConnectAaDialog: () => null }));
vi.mock("@/components/features/banking/old-one-off-bookings", () => ({ RelinkOneOffDialog: () => null }));

import AccountPage from "./page";

const account = (over: Partial<BankAccountRow> = {}): BankAccountRow => ({
  id: "acc-1", tenant_id: "t", name: "HDFC OD 4014", bank_name: "HDFC Bank", account_number_last4: "4014", ifsc: "HDFC0001234",
  account_type: "overdraft", opening_balance: 10_000, opening_balance_date: "2026-04-01", is_active: true,
  notes: null, created_at: "", updated_at: "", ...over,
});
const txn = (id: string, txn_date: string, debit: number, credit: number, description: string, balance_after: number | null = null): BankTransactionRow => ({
  id, tenant_id: "t", bank_account_id: "acc-1", txn_date, description, debit, credit, balance_after, reference: null,
  source: "csv_upload", matched_to_type: null, matched_to_id: null, matched_at: null, matched_by: null, match_confidence: null,
  imported_at: "2026-11-01T00:00:00Z", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z",
});

const table = () => screen.getByRole("table");
const rowOf = (desc: string) => within(table()).getByText(desc).closest("tr") as HTMLElement;

beforeEach(async () => {
  window.history.replaceState(null, "", "/accounting/banking/acc-1");
  state.account = account();
  const { lineBookingMap } = await vi.importActual<typeof import("@/lib/banking/line-booking")>("@/lib/banking/line-booking");
  state.bookings = lineBookingMap([
    { txn_id: "b1", source: "bs_item", sub: "liability", party: "Loan received · Bajaj Finance", amount: 500000 },
    { txn_id: "b2", source: "bs_item", sub: "liability", party: "Loan repaid · Tata Capital", amount: -25000 },
  ]);
  state.txns = [
    { ...txn("b1", "2026-10-01", 0, 500_000, "NEFT BAJAJ FINANCE LOAN"), matched_to_type: "manual" },
    { ...txn("b2", "2026-10-05", 25_000, 0, "ACH TATA CAPITAL EMI"), matched_to_type: "manual" },
    { ...txn("m1", "2026-10-08", 0, 7_000, "RTGS RETURNED"), matched_to_type: "manual" },
  ];
});
afterEach(() => cleanup());

describe("R-2378 a loan booked through Loan / EMI shows its booking on the line", () => {
  it("Bajaj line: badge 'Loan received' + 'Bajaj Finance' linking to the Balance Sheet; never 'Reconciled'", () => {
    render(<AccountPage />);
    const r = rowOf("NEFT BAJAJ FINANCE LOAN");
    expect(within(r).getByText("Loan received")).toBeTruthy();
    const link = within(r).getByTestId("line-booking");
    expect(link.textContent).toBe("Bajaj Finance");
    expect(link.getAttribute("href")).toBe("/accounting/balance-sheet");
    expect(within(r).queryByText("Reconciled")).toBeNull();
    expect(within(rowOf("ACH TATA CAPITAL EMI")).getByText("Loan repaid")).toBeTruthy();
    expect(within(rowOf("ACH TATA CAPITAL EMI")).getByTestId("line-booking").textContent).toBe("Tata Capital");
  });

  it("a real manual line (no booking) still reads Reconciled, with no party link", () => {
    render(<AccountPage />);
    const r = rowOf("RTGS RETURNED");
    expect(within(r).getByText("Reconciled")).toBeTruthy();
    expect(within(r).queryByTestId("line-booking")).toBeNull();
  });
});
