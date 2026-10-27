// @vitest-environment jsdom
//
// R-1952: the screens that pay or match an expense bill use its rest
// (amount − TDS − advance applied − bank parts), never the whole bill.
//   • Bulk "Mark paid": each row and the total show the rest.
//   • Single "Mark paid": the amount shown and on the button is the rest.
//   • "Reconcile" on a paid-but-unbanked bill: the bank line it looks for is the amount paid.
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen } from "@testing-library/react";
import { rupee } from "@/lib/utils";

const debits: { id: string; debit: number; txn_date: string; account_name: string; description: string | null }[] = [];

vi.mock("@/lib/queries/expenses", () => ({
  PAYMENT_METHODS: ["bank_transfer", "upi", "cash"],
  useBulkMarkExpensesPaid: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useMarkExpensePaid: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/queries/bank", () => ({
  useBankAccounts: () => ({ data: [] }),
  useUnmatchedBankDebits: () => ({ data: debits, isLoading: false }),
  useReconcileTransaction: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { BulkMarkPaidDialog } from "./bulk-mark-paid-dialog";
import { MarkPaidDialog } from "./mark-paid-dialog";
import { ReconcileExpenseDialog } from "./reconcile-expense-dialog";
import type { Expense } from "@/lib/queries/expenses";

const bill = (p: Partial<Expense>): Expense => ({
  id: "EXP-1", category: "Repairs & Maintenance", vendor_name: "Verma Contractors", amount: 5000,
  tds_amount: 0, advance_applied: 0, paid_amount: 0, paid: false, payment_method: null,
  expense_date: "2026-10-01", description: null, reconciled_txn_id: null, ...p,
} as unknown as Expense);

afterEach(() => { cleanup(); debits.length = 0; });

describe("R-1952 bulk Mark paid", () => {
  it("₹5,000 bill with ₹3,000 advance + ₹10,000 bill with ₹1,000 TDS → rows ₹2,000 and ₹9,000, total ₹11,000", () => {
    render(<BulkMarkPaidDialog onClose={vi.fn()} onDone={vi.fn()} expenses={[
      bill({ id: "A", advance_applied: 3000 }),
      bill({ id: "B", vendor_name: "Kapoor CA", amount: 10000, tds_amount: 1000 }),
    ]} />);
    expect(screen.getByRole("button", { name: `Mark ${rupee(11000)} paid` })).toBeTruthy();
    expect(screen.getByText(rupee(2000))).toBeTruthy();
    expect(screen.getByText(rupee(9000))).toBeTruthy();
    expect(screen.queryByRole("button", { name: `Mark ${rupee(15000)} paid` })).toBeNull();
  });
});

describe("R-1952 single Mark paid", () => {
  it("shows and pays the rest, with what came off the bill", () => {
    render(<MarkPaidDialog onClose={vi.fn()} expense={bill({ amount: 10000, tds_amount: 1000, paid_amount: 4000 })} />);
    expect(screen.getByRole("button", { name: `Mark ${rupee(5000)} paid` })).toBeTruthy();
    expect(screen.getByText(new RegExp(`bill ${rupee(10000)} − TDS ${rupee(1000)} − already paid ${rupee(4000)}`))).toBeTruthy();
  });
});

describe("R-1952 Reconcile on a paid-but-unbanked bill", () => {
  it("looks for the ₹2,000 actually paid, not the ₹5,000 bill", () => {
    debits.push(
      { id: "t-full", debit: 5000, txn_date: "2026-10-20", account_name: "HDFC", description: "VERMA FULL" },
      { id: "t-rest", debit: 2000, txn_date: "2026-10-20", account_name: "HDFC", description: "VERMA REST" },
    );
    render(<ReconcileExpenseDialog onClose={vi.fn()}
      expense={bill({ paid: true, payment_method: "bank_transfer", advance_applied: 3000 })} />);
    // Only the ₹2,000 line is offered as a match and called exact; the ₹5,000 one is hidden.
    expect(screen.getByText("exact match")).toBeTruthy();
    expect(screen.getByText(/VERMA REST/)).toBeTruthy();
    expect(screen.queryByText(/VERMA FULL/)).toBeNull();
    expect(screen.getByText(/Show 1 line whose amount doesn't match/)).toBeTruthy();
  });
});
