// @vitest-environment jsdom
/* R-2390 (staging 2 Nov 2026): on the ₹40,02,110 FD auto-redeem line, Reconcile → money in →
   Other / manual pre-picked "Other income" — one click would have booked ₹40 L as income.
   Now: nothing is pre-picked unless the narration says interest; an FD redeem / premature closure /
   sweep line pre-picks Interest received → Fixed deposit → that FD with "FD closed" ticked (the
   R-2366 closure path — principal back from the FD + the rest as interest). */
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
    { id: "ca", name: "HDFC Current", account_type: "current", account_number_last4: "4411", is_active: true, current_balance: 500000 },
    { id: "fd1", name: "HDFC FD 50300112233", account_type: "fixed_deposit", account_number_last4: "2233", is_active: true, current_balance: 4000000 },
    { id: "fd2", name: "HDFC FD sweep", account_type: "fixed_deposit", account_number_last4: "7788", is_active: true, current_balance: 250000 },
  ] }),
}));

import { OtherIncomeSection } from "./other-income-section";
import { fdRedeemGuess } from "@/lib/banking/interest-income";

const line = (p: Partial<BankTransactionRow>) => ({
  id: "t1", bank_account_id: "ca", txn_date: "2026-06-12", description: "NEFT CR-SOME PARTY-UTR1",
  debit: 0, credit: 4002110, reference: null, category: null, ...p,
}) as unknown as BankTransactionRow;
const pressed = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-pressed");

afterEach(() => { cleanup(); s.book.mockReset(); s.bookInterest.mockReset(); });

describe("R-2390 Other / manual — no silent default", () => {
  it("a plain credit pre-picks nothing and cannot be booked until the owner picks", () => {
    render(<OtherIncomeSection transaction={line({ credit: 5000 })} onDone={() => {}} />);
    expect(pressed("Interest received")).toBe("false");
    expect(pressed("Other income")).toBe("false");
    const save = screen.getByRole("button", { name: /Pick Interest received or Other income/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(s.book).not.toHaveBeenCalled();
    expect(s.bookInterest).not.toHaveBeenCalled();
  });

  it("after picking Other income it books as before", async () => {
    render(<OtherIncomeSection transaction={line({ credit: 5000 })} onDone={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Other income" }));
    fireEvent.click(screen.getByRole("button", { name: "Book ₹5,000 as other income" }));
    await waitFor(() => expect(s.book).toHaveBeenCalledWith({ transactionId: "t1", head: "other" }));
  });

  it("in the sheet the footer save is there but disabled with a reason", async () => {
    const report = vi.fn();
    render(<OtherIncomeSection transaction={line({ credit: 5000 })} onDone={() => {}} onFooterSave={report} />);
    await waitFor(() => expect(report).toHaveBeenCalled());
    const last = report.mock.calls.at(-1)?.[0];
    expect(last.disabledReason).toMatch(/Pick Interest received or Other income/);
  });
});

describe("R-2390 FD redeem line → Interest received · Fixed deposit · that FD · FD closed", () => {
  it("owner's staging line: AUTO_REDEEM with the FD number pre-picks the FD closure", async () => {
    render(<OtherIncomeSection transaction={line({ description: "TO FD 50300112233 AUTO_REDEEM" })} onDone={() => {}} />);
    expect(pressed("Interest received")).toBe("true");
    expect(pressed("Other income")).toBe("false");
    expect(pressed("Fixed deposit")).toBe("true");
    expect((screen.getByLabelText("FD account") as HTMLSelectElement).value).toBe("fd1");
    expect((screen.getByRole("checkbox", { name: /FD closed/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Principal back from the FD") as HTMLInputElement).value).toBe("4000000");
    fireEvent.click(screen.getByRole("button", { name: "Book FD closure: ₹40,00,000 principal + ₹2,110 interest" }));
    await waitFor(() => expect(s.bookInterest).toHaveBeenCalledWith({
      transactionId: "t1", source: "fd", fdAccountId: "fd1", principal: 4000000, interest: 2110, tds: 0,
    }));
    expect(s.book).not.toHaveBeenCalled();
  });

  it("PREMAT / REDEEM / SWEEP without a known FD number: Interest · Fixed deposit, FD left to pick", () => {
    for (const d of ["FD PREMAT CLOSURE 99887766", "REDEEM OF DEPOSIT", "AUTO-SWEEP IN"]) {
      render(<OtherIncomeSection transaction={line({ description: d })} onDone={() => {}} />);
      expect(pressed("Interest received")).toBe("true");
      expect(pressed("Fixed deposit")).toBe("true");
      expect((screen.getByLabelText("FD account") as HTMLSelectElement).value).toBe("");
      cleanup();
    }
  });

  it("the FD is matched by its last 4 digits too", () => {
    render(<OtherIncomeSection transaction={line({ description: "SWEEP REDEMPTION 000000447788", credit: 260000 })} onDone={() => {}} />);
    expect((screen.getByLabelText("FD account") as HTMLSelectElement).value).toBe("fd2");
    expect((screen.getByRole("checkbox", { name: /FD closed/ }) as HTMLInputElement).checked).toBe(true);
  });
});

describe("R-2390 fdRedeemGuess", () => {
  const fds = [
    { id: "fd1", name: "HDFC FD 50300112233", account_number_last4: "2233" },
    { id: "fd2", name: "HDFC FD sweep", account_number_last4: "7788" },
    { id: "fd3", name: "SBI FD", account_number_last4: "7788" },
  ];
  it("redeem words", () => {
    expect(fdRedeemGuess("TO FD 50300112233 AUTO_REDEEM", fds)).toEqual({ redeem: true, fdId: "fd1" });
    expect(fdRedeemGuess("FD PREMAT 1", fds).redeem).toBe(true);
    expect(fdRedeemGuess("AUTO-SWEEP", fds).redeem).toBe(true);
    expect(fdRedeemGuess("NEFT CR-ACME-UTR", fds)).toEqual({ redeem: false, fdId: null });
  });
  it("an FD number alone (no redeem word) also counts", () => {
    expect(fdRedeemGuess("BY TRANSFER 50300112233", fds)).toEqual({ redeem: true, fdId: "fd1" });
  });
  it("two FDs with the same last 4 → no FD picked", () => {
    expect(fdRedeemGuess("SWEEP 0000447788", fds)).toEqual({ redeem: true, fdId: null });
  });
  it("interest-only lines are not a redeem (the FD is still named)", () => {
    expect(fdRedeemGuess("INT ON FD 9911", fds).redeem).toBe(false);
    expect(fdRedeemGuess("INT ON FD 50300112233", fds)).toEqual({ redeem: false, fdId: "fd1" });
  });
  it("a short number (UTR bits, dates) never names an FD", () => {
    expect(fdRedeemGuess("NEFT 2233 ACME", fds)).toEqual({ redeem: false, fdId: null });
  });
});
