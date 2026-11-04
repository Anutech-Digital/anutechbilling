// @vitest-environment jsdom
/* R-2366 (2 Nov 2026, Pardeep: "app me interest income ka option banao"): Reconcile → money in →
   Interest received: where it came from (FD / savings / other), which FD, an FD premature closure
   in ONE save (principal back from the FD + interest) and TDS the bank deducted. Owner's staging
   example: 12 Jun FD closure line = principal + interest; small SB interest credits. */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { BankTransactionRow } from "@/lib/queries/bank";

const s = vi.hoisted(() => ({ book: vi.fn(), bookInterest: vi.fn() }));
vi.mock("@/lib/queries/bank-other-income", () => ({
  useBookOtherIncome: () => ({ mutateAsync: s.book, isPending: false }),
  useBookInterestIncome: () => ({ mutateAsync: s.bookInterest, isPending: false }),
}));
vi.mock("@/lib/queries/bank", () => ({
  useBankAccounts: () => ({ data: [
    { id: "ca", name: "HDFC Current", bank_name: "HDFC", account_type: "current", is_active: true, current_balance: 500000 },
    { id: "fd1", name: "HDFC FD 5012", bank_name: "HDFC", account_type: "fixed_deposit", is_active: true, current_balance: 100000 },
    { id: "fd2", name: "HDFC FD old", bank_name: "HDFC", account_type: "fixed_deposit", is_active: false, current_balance: 0 },
  ] }),
}));

import { OtherIncomeSection } from "./other-income-section";

const line = (p: Partial<BankTransactionRow>) => ({
  id: "t1", bank_account_id: "ca", txn_date: "2026-06-12", description: "FD PREMAT CLOSURE INTEREST 5012",
  debit: 0, credit: 105400, reference: null, category: null, ...p,
}) as unknown as BankTransactionRow;

afterEach(() => { cleanup(); s.book.mockReset(); s.bookInterest.mockReset(); });

describe("R-2366 interest income", () => {
  it("small savings interest: Savings picked from the narration, booked in one click", async () => {
    const done = vi.fn();
    render(<OtherIncomeSection transaction={line({ description: "SB INTEREST CREDIT", credit: 88 })} onDone={done} />);
    expect(screen.getByRole("button", { name: "Savings account" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Book ₹88 as interest received" }));
    await waitFor(() => expect(s.bookInterest).toHaveBeenCalledWith({
      transactionId: "t1", source: "savings", fdAccountId: null, principal: 0, interest: 88, tds: 0,
    }));
    expect(done).toHaveBeenCalled();
  });

  it("FD closure: pick the FD, principal defaults to its balance, TDS → income booked gross", async () => {
    render(<OtherIncomeSection transaction={line({})} onDone={() => {}} />);
    expect(screen.getByRole("button", { name: "Fixed deposit" }).getAttribute("aria-pressed")).toBe("true");
    // only active FD accounts, not this account
    const fdSelect = screen.getByLabelText("FD account") as HTMLSelectElement;
    expect(Array.from(fdSelect.options).map((o) => o.value)).toEqual(["", "fd1"]);
    fireEvent.change(fdSelect, { target: { value: "fd1" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /FD closed/ }));
    expect((screen.getByLabelText("Principal back from the FD") as HTMLInputElement).value).toBe("100000");
    fireEvent.change(screen.getByLabelText("TDS deducted by the bank"), { target: { value: "600" } });
    expect(screen.getByText(/₹5,400 credited \+ ₹600 TDS/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Book FD closure: ₹1,00,000 principal + ₹6,000 interest" }));
    await waitFor(() => expect(s.bookInterest).toHaveBeenCalledWith({
      transactionId: "t1", source: "fd", fdAccountId: "fd1", principal: 100000, interest: 5400, tds: 600,
    }));
  });

  it("principal more than the FD holds can't be saved", () => {
    render(<OtherIncomeSection transaction={line({ credit: 205400 })} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("FD account"), { target: { value: "fd1" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /FD closed/ }));
    fireEvent.change(screen.getByLabelText("Principal back from the FD"), { target: { value: "2,00,000" } });
    expect(screen.getByText(/more than this FD's balance/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Book FD closure/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(s.bookInterest).not.toHaveBeenCalled();
  });

  it("FD interest without a closure: optional FD named, whole line is interest", async () => {
    render(<OtherIncomeSection transaction={line({ description: "INT ON FD 5012", credit: 1500 })} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("FD account"), { target: { value: "fd1" } });
    fireEvent.click(screen.getByRole("button", { name: "Book ₹1,500 as interest received" }));
    await waitFor(() => expect(s.bookInterest).toHaveBeenCalledWith({
      transactionId: "t1", source: "fd", fdAccountId: "fd1", principal: 0, interest: 1500, tds: 0,
    }));
  });

  it("Other income still books the old way", async () => {
    render(<OtherIncomeSection transaction={line({ description: "INTEREST", credit: 500 })} onDone={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Other income" }));
    expect(screen.queryByLabelText("TDS deducted by the bank")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Book ₹500 as other income" }));
    await waitFor(() => expect(s.book).toHaveBeenCalledWith({ transactionId: "t1", head: "other" }));
  });
});
