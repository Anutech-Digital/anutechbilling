// @vitest-environment jsdom
/* R-2095 (30 Oct 2026, September reconcile): FD interest reached no income line; an FD sweep never
   moved the FD account. Reconcile → money in → Other: "Interest received" books other income;
   Own transfer: pick the other account (or add a fixed deposit) and post the line as a transfer. */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { BankTransactionRow } from "@/lib/queries/bank";

const s = vi.hoisted(() => ({ book: vi.fn(), post: vi.fn(), create: vi.fn() }));
vi.mock("@/lib/queries/bank-other-income", () => ({
  useBookOtherIncome: () => ({ mutateAsync: s.book, isPending: false }),
  useReconcileAsTransfer: () => ({ mutateAsync: s.post, isPending: false }),
}));
vi.mock("@/lib/queries/bank", () => ({
  useBankAccounts: () => ({ data: [
    { id: "ca", name: "HDFC Current", bank_name: "HDFC", account_type: "current", is_active: true },
    { id: "sb", name: "ICICI Savings", bank_name: "ICICI", account_type: "savings", is_active: true },
    { id: "fd1", name: "HDFC FD 1", bank_name: "HDFC", account_type: "fixed_deposit", is_active: true },
  ] }),
  useCreateBankAccount: () => ({ mutateAsync: s.create, isPending: false }),
}));

import { OtherIncomeSection, looksLikeInterest } from "./other-income-section";
import { OwnTransferSection, transferAccountOptions } from "./own-transfer-section";

const line = (p: Partial<BankTransactionRow>) => ({
  id: "t1", bank_account_id: "ca", txn_date: "2026-09-30", description: "INT.PD 01-07-26 TO 30-09-26",
  debit: 0, credit: 1234, reference: null, category: null, ...p,
}) as unknown as BankTransactionRow;

afterEach(() => { cleanup(); s.book.mockReset(); s.post.mockReset(); s.create.mockReset(); });

describe("R-2095 interest received", () => {
  it("an INT.PD narration starts on Interest received and books it", async () => {
    expect(looksLikeInterest("INT.PD 01-07-26 TO 30-09-26")).toBe(true);
    expect(looksLikeInterest("NEFT CR ACME")).toBe(false);
    const done = vi.fn();
    render(<OtherIncomeSection transaction={line({})} onDone={done} />);
    fireEvent.click(screen.getByRole("button", { name: /Book ₹1,234 as interest received/ }));
    await waitFor(() => expect(s.book).toHaveBeenCalledWith({ transactionId: "t1", head: "interest" }));
    expect(done).toHaveBeenCalled();
  });
});

describe("R-2095 FD sweep as a transfer", () => {
  it("other accounts only, fixed deposits first", () => {
    expect(transferAccountOptions([
      { id: "ca", name: "HDFC Current" }, { id: "sb", name: "ICICI Savings", account_type: "savings" },
      { id: "fd1", name: "HDFC FD 1", account_type: "fixed_deposit" },
    ], "ca").map((a) => a.id)).toEqual(["fd1", "sb"]);
  });
  it("sweep-in: pick the FD and post", async () => {
    render(<OwnTransferSection transaction={line({ description: "SWEEP IN", credit: 50000 })} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("Other account"), { target: { value: "fd1" } });
    fireEvent.click(screen.getByRole("button", { name: /Post ₹50,000 as transfer/ }));
    await waitFor(() => expect(s.post).toHaveBeenCalledWith({ transactionId: "t1", otherAccountId: "fd1" }));
  });
  it("+ New fixed deposit account adds one and picks it", async () => {
    s.create.mockResolvedValue({ id: "fd2" });
    render(<OwnTransferSection transaction={line({ description: "SWEEP IN", credit: 50000 })} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("Other account"), { target: { value: "__new" } });
    fireEvent.change(screen.getByLabelText("Fixed deposit name"), { target: { value: "HDFC FD 2" } });
    fireEvent.change(screen.getByLabelText("Fixed deposit bank"), { target: { value: "HDFC" } });
    fireEvent.click(screen.getByRole("button", { name: "Add FD" }));
    await waitFor(() => expect(s.create).toHaveBeenCalledWith(expect.objectContaining({ name: "HDFC FD 2", bank_name: "HDFC", account_type: "fixed_deposit" })));
  });
});
