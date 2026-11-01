// @vitest-environment jsdom
/* R-2341 — Set up this loan → "Loan money came into HDFC Current": the statement already has the
   disbursal credit (NEFT CR HDFC BANK LOAN DISB ₹2,50,000 on 4 Sep 2026). The dialog lists it and
   picks it, so Save links the loan to THAT line — no new money-in line (cash counted once). A new
   line is offered only when the owner says the credit is not in the statement, with a warning.
   Owner default unchanged: "Taken before these books — no bank entry". */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const setUp = vi.fn();
let lines: unknown[] = [];
const linesArgs = vi.fn();
vi.mock("@/lib/queries/emi", () => ({
  useEmiMatches: () => ({ data: [], isLoading: false }),
  useEmiPurchases: () => ({ data: [], isLoading: false }),
  useEmiSchedule: () => ({ data: { rows: [], payments: [] }, isLoading: false }),
  useReconcileDebitToEmi: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/banking/loan-setup-query", () => ({
  useSetUpEmiLoan: () => ({ mutateAsync: setUp, isPending: false }),
  useLoanDisbursalLines: (...a: unknown[]) => { linesArgs(...a); return { data: lines, isLoading: false }; },
}));
vi.mock("@/lib/queries/bank", () => ({
  useBankAccounts: () => ({ data: [
    { id: "acc-1", name: "HDFC Current", is_active: true, account_type: "current" },
    { id: "acc-2", name: "Kotak Savings", is_active: true, account_type: "savings" },
  ] }),
}));
vi.mock("@/components/features/accounting/emi-loan-dialogs", () => ({
  EmiPurchaseDialog: () => <div>purchase dialog</div>,
  EmiPrepayDialog: () => <div>prepay dialog</div>,
}));

import { EmiRepaymentSection } from "./emi-repayment-section";

const txn = { id: "t1", debit: 19054, txn_date: "2026-10-05", bank_account_id: "acc-1", description: "NACH DR HDFC BANK BIKE EMI" };
const type = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const disb = { id: "d1", txn_date: "2026-09-04", credit: 250000, debit: 0, description: "NEFT CR HDFC BANK LOAN DISB", matched_to_type: null };

function openAndFill(account: string | null) {
  render(<EmiRepaymentSection transaction={txn} onDone={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /Set up this loan/ }));
  type(/^Amount still owed/, "250000");
  type(/^Interest rate/, "11");
  type(/^EMIs left/, "14");
  if (account) fireEvent.change(screen.getByLabelText(/^Loan money came into/), { target: { value: account } });
}

afterEach(cleanup);
beforeEach(() => {
  setUp.mockReset(); setUp.mockResolvedValue({ purchase_id: "p9" }); linesArgs.mockReset();
  lines = [
    disb,
    { id: "d2", txn_date: "2026-09-05", credit: 250002, debit: 0, description: "NEFT CR SOMEONE", matched_to_type: null }, // ₹2 off
    { id: "d3", txn_date: "2026-09-06", credit: 250000, debit: 0, description: "NEFT CR DONE", matched_to_type: "payment" },
  ];
});

describe("R-2341 — the loan money is the imported credit, not a new line", () => {
  it("default stays 'Taken before these books': no statement lines asked for, none sent", async () => {
    openAndFill(null);
    expect(screen.queryByText(/NEFT CR HDFC BANK LOAN DISB/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Save loan & reconcile EMI 1/ }));
    await vi.waitFor(() => expect(setUp).toHaveBeenCalled());
    expect(setUp.mock.calls[0][0]).toMatchObject({ account_id: null, received_on: null, received_txn_id: null });
  });

  it("came into HDFC: lists only the matching unmatched credit, picks it, and Save links THAT line (no new line)", async () => {
    openAndFill("acc-1");
    expect(linesArgs).toHaveBeenCalledWith("acc-1", 250000, expect.objectContaining({ from: "2026-08-21", to: "2026-09-20" }));
    const pick = screen.getByRole("radio", { name: /NEFT CR HDFC BANK LOAN DISB/ }) as HTMLInputElement;
    expect(pick.checked).toBe(true);
    expect(screen.queryByRole("radio", { name: /NEFT CR SOMEONE/ })).toBeNull();
    expect(screen.queryByRole("radio", { name: /NEFT CR DONE/ })).toBeNull();
    // The date comes from the line — no "Received on" to type, no "counted twice" warning.
    expect(screen.queryByLabelText(/^Received on/)).toBeNull();
    expect(screen.queryByText(/counted twice/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Save loan & reconcile EMI 1/ }));
    await vi.waitFor(() => expect(setUp).toHaveBeenCalled());
    expect(setUp.mock.calls[0][0]).toMatchObject({
      account_id: "acc-1", received_on: "2026-09-04", received_txn_id: "d1", reconcile_txn_id: "t1",
    });
  });

  it("'Not in the statement': a new money-in line, with the counted-twice warning", async () => {
    openAndFill("acc-1");
    fireEvent.click(screen.getByRole("radio", { name: /Not in my imported statement/ }));
    expect(screen.getByText(/Only if this credit is not in your imported statement — otherwise it is counted twice/)).toBeTruthy();
    type(/^Received on/, "2026-09-04");
    fireEvent.click(screen.getByRole("button", { name: /Save loan & reconcile EMI 1/ }));
    await vi.waitFor(() => expect(setUp).toHaveBeenCalled());
    expect(setUp.mock.calls[0][0]).toMatchObject({ account_id: "acc-1", received_on: "2026-09-04", received_txn_id: null });
  });

  it("no such credit in the statement: the new line is offered with the warning", async () => {
    lines = [];
    openAndFill("acc-2");
    expect(screen.getByText(/No unmatched money-in line of ₹2,50,000/)).toBeTruthy();
    expect(screen.getByText(/Only if this credit is not in your imported statement — otherwise it is counted twice/)).toBeTruthy();
    type(/^Received on/, "2026-09-05");
    fireEvent.click(screen.getByRole("button", { name: /Save loan & reconcile EMI 1/ }));
    await vi.waitFor(() => expect(setUp).toHaveBeenCalled());
    expect(setUp.mock.calls[0][0]).toMatchObject({ account_id: "acc-2", received_on: "2026-09-05", received_txn_id: null });
  });
});
