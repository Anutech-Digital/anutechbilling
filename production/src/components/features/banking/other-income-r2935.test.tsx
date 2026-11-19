// @vitest-environment jsdom
/* R-2935 (staging 18 Nov 2026, Excel HDFC 4523): the bank paid a closed FD on three lines. The
   principal (+₹10,00,000) was reconciled as an own transfer from the FD. On the interest line
   "FD REDEEM INTEREST -50301205948354/1" (+₹8,014) Reconcile → Other / manual → Interest received →
   Fixed deposit, "FD closed" unticked, "Book ₹8,014 as interest received" did nothing: the R-2390
   guard held every line whose narration says REDEEM, and the footer button gave no reason. */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { BankTransactionRow } from "@/lib/queries/bank";

const s = vi.hoisted(() => ({ book: vi.fn(), bookInterest: vi.fn(), fdBalance: 0 }));
vi.mock("@/lib/queries/bank-other-income", () => ({
  useBookOtherIncome: () => ({ mutateAsync: s.book, isPending: false }),
  useBookInterestIncome: () => ({ mutateAsync: s.bookInterest, isPending: false }),
}));
vi.mock("@/lib/queries/bank", () => ({
  useBankAccounts: () => ({ data: [
    { id: "ca", name: "HDFC 4523", account_type: "current", account_number_last4: "4523", is_active: true, current_balance: 500000 },
    { id: "fd1", name: "HDFC FD 50301205948354", account_type: "fixed_deposit", account_number_last4: "8354", is_active: true, current_balance: s.fdBalance },
    { id: "fd2", name: "HDFC FD other", account_type: "fixed_deposit", account_number_last4: "1100", is_active: true, current_balance: 2500000 },
  ] }),
}));

import { OtherIncomeSection } from "./other-income-section";

const line = (p: Partial<BankTransactionRow>) => ({
  id: "t1", bank_account_id: "ca", txn_date: "2025-11-21", description: "FD REDEEM INTEREST -50301205948354/1",
  debit: 0, credit: 8014, reference: null, category: null, ...p,
}) as unknown as BankTransactionRow;
const save = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

afterEach(() => { cleanup(); s.book.mockReset(); s.bookInterest.mockReset(); s.fdBalance = 0; });

describe("R-2935 the interest line of an FD paid on three lines", () => {
  it("owner's line: FD picked, 'FD closed' NOT ticked, and one click books ₹8,014 as interest", async () => {
    render(<OtherIncomeSection transaction={line({})} onDone={() => {}} />);
    expect(screen.getByRole("button", { name: "Interest received" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Fixed deposit" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText("FD account") as HTMLSelectElement).value).toBe("fd1");
    expect((screen.getByRole("checkbox", { name: /FD closed/ }) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByText(/looks like an FD coming back/)).toBeNull();
    const btn = save("Book ₹8,014 as interest received");
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(s.bookInterest).toHaveBeenCalledWith({
      transactionId: "t1", source: "fd", fdAccountId: "fd1", principal: 0, interest: 8014, tds: 0,
    }));
    expect(s.book).not.toHaveBeenCalled();
  });

  it("no FD named (source Other): held until the owner ticks 'Interest only', then ₹6,678 books", async () => {
    render(<OtherIncomeSection transaction={line({ credit: 6678 })} onDone={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    expect(save("Book ₹6,678 as interest received").disabled).toBe(true);
    expect(screen.getByText(/Tick “Interest only” if the principal came on its own bank line/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /Interest only/ }));
    expect(save("Book ₹6,678 as interest received").disabled).toBe(false);
    fireEvent.click(save("Book ₹6,678 as interest received"));
    await waitFor(() => expect(s.bookInterest).toHaveBeenCalledWith(expect.objectContaining({ source: "other", fdAccountId: null, principal: 0, interest: 6678 })));
  });

  it("an FD that still holds more than the line (a part-withdrawal looks the same) → asked, never silent", () => {
    s.fdBalance = 1000000;
    render(<OtherIncomeSection transaction={line({})} onDone={() => {}} />);
    expect((screen.getByRole("checkbox", { name: /FD closed/ }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: /Interest only/ }) as HTMLInputElement).checked).toBe(false);
    expect(save("Book ₹8,014 as interest received").disabled).toBe(true);
    fireEvent.click(save("Book ₹8,014 as interest received"));
    expect(s.bookInterest).not.toHaveBeenCalled();
  });

  it("the owner's line (FD at ₹0) is not asked, and says where a separate TAX line goes", () => {
    render(<OtherIncomeSection transaction={line({})} onDone={() => {}} />);
    expect(screen.queryByRole("checkbox", { name: /Interest only/ })).toBeNull();
    expect(screen.getByText(/leave TDS at 0 here and book that line under Tax → TDS cut by bank/)).toBeTruthy();
  });

  it("a principal / redeem line is not 'Other income' either", () => {
    render(<OtherIncomeSection transaction={line({ description: "FD REDEEM PRINCIPAL -50301205948354/1", credit: 1000000 })} onDone={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Other income" }));
    const btn = save("Book ₹10,00,000 as other income");
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/principal coming back.*Own transfer/)).toBeTruthy();
    fireEvent.click(btn);
    expect(s.book).not.toHaveBeenCalled();
  });

  it("one line with principal AND interest keeps the closure message (not 'use Own transfer')", () => {
    s.fdBalance = 1000000;
    render(<OtherIncomeSection transaction={line({ description: "FD PREMAT PRINCIPAL AND INTEREST 50301205948354", credit: 1008014 })} onDone={() => {}} />);
    expect(screen.queryByText(/reconcile it under Own transfer/)).toBeNull();
    expect((screen.getByRole("checkbox", { name: /FD closed/ }) as HTMLInputElement).checked).toBe(true);
    expect(save("Book FD closure: ₹10,00,000 principal + ₹8,014 interest").disabled).toBe(false);
  });

  it("the FD still holds money that fits in the line → the principal may be in it: held, with the reason", () => {
    s.fdBalance = 8000;
    render(<OtherIncomeSection transaction={line({})} onDone={() => {}} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /FD closed/ }));   // pre-ticked for a closure; untick
    expect(screen.getByText(/looks like an FD coming back/)).toBeTruthy();
    expect(save(/as interest received/).disabled).toBe(true);
    fireEvent.click(save(/as interest received/));
    expect(s.bookInterest).not.toHaveBeenCalled();
  });

  it("the PRINCIPAL line is never income: held, and it says where it goes", () => {
    render(<OtherIncomeSection transaction={line({ description: "FD REDEEM PRINCIPAL -50301205948354/1", credit: 1000000 })} onDone={() => {}} />);
    expect(screen.getByText(/principal coming back.*Own transfer/)).toBeTruthy();
    expect(save(/as interest received/).disabled).toBe(true);
    fireEvent.click(save(/as interest received/));
    expect(s.bookInterest).not.toHaveBeenCalled();
    expect(s.book).not.toHaveBeenCalled();
  });

  it("a plain redeem line (no INTEREST word) is held as before (R-2390)", () => {
    render(<OtherIncomeSection transaction={line({ description: "TO FD 50301205948354 AUTO_REDEEM", credit: 8014 })} onDone={() => {}} />);
    const closed = screen.getByRole("checkbox", { name: /FD closed/ }) as HTMLInputElement;
    expect(closed.checked).toBe(true);   // pre-ticked: the closure path
    fireEvent.click(closed);
    expect(screen.getByText(/looks like an FD coming back/)).toBeTruthy();
    expect(save(/as interest received/).disabled).toBe(true);
  });
});

describe("R-2935 a held save says why next to the button (sheet footer)", () => {
  it("the footer gets the reason, not a silent disabled button", async () => {
    const report = vi.fn();
    render(<OtherIncomeSection transaction={line({ description: "FD REDEEM PRINCIPAL -50301205948354/1", credit: 1000000 })} onDone={() => {}} onFooterSave={report} />);
    await waitFor(() => expect(report).toHaveBeenCalled());
    expect(report.mock.calls.at(-1)?.[0].disabledReason).toMatch(/principal coming back/);
  });
  it("the owner's interest line: the footer save is enabled with no reason", async () => {
    const report = vi.fn();
    render(<OtherIncomeSection transaction={line({})} onDone={() => {}} onFooterSave={report} />);
    await waitFor(() => expect(report).toHaveBeenCalled());
    const last = report.mock.calls.at(-1)?.[0];
    expect(last.label).toBe("Book ₹8,014 as interest received");
    expect(last.disabledReason).toBeNull();
    expect(last.disabled).toBe(false);
  });
});
