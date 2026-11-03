// @vitest-environment jsdom
/* R-2400 — the bank account page shows a running "Balance" after Jama (Cr.) on every row
   (owner, 3 Nov: "od account me running balance bhi har row me show karo"). The newest row's
   balance equals "Balance in bank"; a searched view keeps each row's true balance; an OD
   account shows −₹; a statement balance more than ₹1 away gets an amber dot. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";

import type { BankAccountRow, BankTransactionRow } from "@/lib/queries/bank";

const state = vi.hoisted(() => ({
  account: null as unknown,
  txns: [] as unknown[],
}));
const { noData, mutation } = vi.hoisted(() => ({ noData: () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
  mutation: () => ({ mutate: vi.fn(), isPending: false, isSuccess: false, data: undefined, reset: vi.fn() }) }));

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "acc-1" }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "owner" } }) }));
vi.mock("@/lib/queries/bank", async (orig) => ({
  ...(await orig<object>()),
  useBankAccount: () => ({ data: state.account, isLoading: false, isError: false, refetch: vi.fn() }),
  useBankTransactions: () => ({ data: state.txns, isLoading: false, isError: false, refetch: vi.fn() }),
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
vi.mock("@/lib/queries/vendors", async (orig) => ({ ...(await orig<object>()), useVendors: noData }));
vi.mock("@/lib/queries/txn-category-rules", async (orig) => ({ ...(await orig<object>()), useTxnCategoryRules: noData }));
vi.mock("@/lib/queries/bank-debit-pay-for", async (orig) => ({ ...(await orig<object>()), useVendorNarrationAliases: noData }));
vi.mock("@/lib/queries/bank-aa", async (orig) => ({ ...(await orig<object>()), useBankAaConnection: noData, useFetchAaNow: mutation }));
vi.mock("@/lib/banking/manual-reconcile", async (orig) => ({ ...(await orig<object>()), useOwnerBookingNotes: noData }));
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
const balanceCell = (desc: string) => within(rowOf(desc)).getByTestId("running-balance");
const balanceInBank = () => screen.getByText("Balance in bank").nextElementSibling as HTMLElement;

beforeEach(() => {
  window.history.replaceState(null, "", "/accounting/banking/acc-1");
  state.account = account();
  state.txns = [
    txn("t1", "2026-04-02", 0, 5_000, "NEFT FROM ACME"),
    txn("t2", "2026-04-03", 1_500, 0, "AWS BILL"),
    txn("t3", "2026-04-04", 0, 37, "INTEREST CREDIT"),
    txn("t4", "2026-04-05", 2_000, 0, "RENT APRIL"),
  ];
});
afterEach(() => cleanup());

describe("R-2400 running Balance column", () => {
  it("has a Balance column right after Jama (Cr.), and the newest row equals Balance in bank", () => {
    render(<AccountPage />);
    const heads = within(table()).getAllByRole("columnheader").map((h) => h.textContent?.trim());
    expect(heads.indexOf("Balance")).toBe(heads.indexOf("Jama (Cr.)") + 1);
    expect(balanceCell("NEFT FROM ACME").textContent).toBe("₹15,000");
    expect(balanceCell("AWS BILL").textContent).toBe("₹13,500");
    expect(balanceCell("INTEREST CREDIT").textContent).toBe("₹13,537");
    expect(balanceCell("RENT APRIL").textContent).toBe("₹11,537");
    expect(balanceInBank().textContent).toBe("₹11,537");
    // Newest first: the first body row is the newest line.
    const firstRow = within(table()).getAllByRole("row")[1];
    expect(within(firstRow).getByTestId("running-balance").textContent).toBe(balanceInBank().textContent);
  });

  it("a search keeps each row's true balance, not a balance of only the rows shown", async () => {
    window.history.replaceState(null, "", "/accounting/banking/acc-1?q=interest");
    await act(async () => { render(<AccountPage />); });
    expect(within(table()).queryByText("RENT APRIL")).toBeNull();
    expect(balanceCell("INTEREST CREDIT").textContent).toBe("₹13,537");
  });

  it("an OD account shows its balance with a minus; a statement off by more than ₹1 gets an amber dot", () => {
    state.account = account({ opening_balance: -10_000 });
    state.txns = [
      txn("o1", "2026-10-01", 50_000, 0, "TRANSFER OUT", -60_000),
      txn("o2", "2026-10-02", 501, 0, "BANK CHARGES", -60_000),
    ];
    render(<AccountPage />);
    expect(balanceCell("TRANSFER OUT").textContent).toBe("−₹60,000");
    expect(within(rowOf("TRANSFER OUT")).queryByTestId("statement-mismatch")).toBeNull();
    expect(balanceCell("BANK CHARGES").textContent).toBe("−₹60,501");
    const dot = within(rowOf("BANK CHARGES")).getByTestId("statement-mismatch");
    expect(dot.getAttribute("title")).toBe("Statement says −₹60,000");
    expect(balanceInBank().textContent).toBe("−₹60,501");
  });

  it("sorted by amount: the column stays and its header says it is the balance in date order", async () => {
    window.history.replaceState(null, "", "/accounting/banking/acc-1?sort=high");
    await act(async () => { render(<AccountPage />); });
    const head = within(table()).getByRole("columnheader", { name: /Balance/ });
    expect(head.getAttribute("title")).toBe("Balance after this line, in date order (the list is sorted by amount)");
    expect(balanceCell("AWS BILL").textContent).toBe("₹13,500");
  });
});
