// @vitest-environment jsdom
/* R-2340 — Banking → a money-IN line (NEFT CR VINOD HEM RAJ ₹16,476 on 5 Oct 2026) → Loan / EMI.
   No loan given in the books: "Set up loan given" (₹3,50,000 · 12% · 24 receipts) → Save sets the
   loan up AND reconciles this line as receipt 1 (₹12,976 principal + ₹3,500 interest), default
   "Given before these books — no bank entry". Next month's ₹16,476 line is suggested as receipt 2. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { buildLoan, type LoanGivenRow } from "@/lib/queries/loans-given";

const setUp = vi.fn();
const reconcile = vi.fn();
let loans: unknown[] = [];
let role = "owner";
let outLines: unknown[] = [];
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role } }) }));
vi.mock("@/lib/queries/bank", () => ({
  useBankAccounts: () => ({ data: [{ id: "acc-1", name: "HDFC Current", is_active: true, account_type: "current" }] }),
}));
vi.mock("@/lib/queries/loans-given", async (orig) => ({
  ...(await orig<typeof import("@/lib/queries/loans-given")>()),
  useLoansGiven: () => ({ data: loans, isLoading: false }),
  useSetUpLoanGiven: () => ({ mutateAsync: setUp, isPending: false }),
  useReconcileCreditToLoanGiven: () => ({ mutateAsync: reconcile, isPending: false }),
  useLoanGivenDisbursalLines: () => ({ data: outLines, isLoading: false }),
}));

import { LoanGivenReceiptSection } from "./loan-given-receipt-section";

const line1 = { id: "t1", credit: 16476, txn_date: "2026-10-05", description: "NEFT CR VINOD HEM RAJ" };
const line2 = { id: "t2", credit: 16476, txn_date: "2026-11-05", description: "NEFT CR VINOD HEM RAJ" };
const type = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

const vinodRow = {
  id: "loan-v", tenant_id: "t", borrower_name: "Vinod Hem Raj", borrower_type: "person", customer_id: null, vendor_id: null,
  principal: 350000, given_on: "2026-09-05", interest_rate: 12, repayment_plan: "emi", due_on: "2026-10-05", instalments: 24,
  emi_amount: 16476, paid_from_account_id: null, bank_txn_id: null, notes: null, status: "open", closed_on: null,
  created_by: null, created_at: "", updated_at: "",
} as unknown as LoanGivenRow;
const receipt1 = {
  id: "r1", tenant_id: "t", loan_id: "loan-v", repaid_on: "2026-10-05", amount: 16476, principal_part: 12976, interest_part: 3500,
  mode: "bank", reference: null, bank_account_id: "acc-1", bank_txn_id: "t1", notes: null, created_by: null, created_at: "",
};

afterEach(cleanup);
beforeEach(() => {
  setUp.mockReset(); setUp.mockResolvedValue({ loan_id: "loan-v", receipt: { seq: 1 } });
  reconcile.mockReset(); reconcile.mockResolvedValue({ seq: 2 });
  loans = []; role = "owner"; outLines = [];
});

describe("R-2340 — set up a loan given from a money-in line", () => {
  it("no loan given yet → Set up loan given → Save reconciles this line as receipt 1 (lent before these books)", async () => {
    const onDone = vi.fn();
    render(<LoanGivenReceiptSection transaction={line1} onDone={onDone} />);
    expect(screen.getByText(/No loan you gave is recorded yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Set up loan given/ }));
    type(/^Borrower/, "Vinod Hem Raj");
    type(/^Amount lent/, "350000");
    type(/^Interest rate/, "12");
    type(/^Receipts/, "24");
    // EMI and first receipt default to this line.
    expect((screen.getByLabelText(/^Monthly receipt/) as HTMLInputElement).value).toBe("16476");
    expect((screen.getByLabelText(/^First receipt date/) as HTMLInputElement).value).toBe("2026-10-05");
    const split = screen.getByTestId("loan-given-first-receipt");
    expect(split.textContent).toContain("12,976");
    expect(split.textContent).toContain("3,500");
    expect((screen.getByLabelText(/^Money lent/) as HTMLSelectElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: /Save loan & reconcile receipt 1/ }));
    await vi.waitFor(() => expect(setUp).toHaveBeenCalled());
    expect(setUp.mock.calls[0][0]).toEqual({
      borrower: "Vinod Hem Raj", borrower_type: "person", principal: 350000, interest_rate: 12, emi: 16476,
      instalments: 24, first_due_on: "2026-10-05", disbursal_txn_id: null, reconcile_txn_id: "t1",
    });
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("the money lent can be an imported unmatched money-out line — that line, never a new one", async () => {
    outLines = [{ id: "out-1", txn_date: "2026-09-01", debit: 350000, description: "RTGS DR VINOD HEM RAJ", bank_account_id: "acc-1" }];
    render(<LoanGivenReceiptSection transaction={line1} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Set up loan given/ }));
    type(/^Borrower/, "Vinod Hem Raj");
    type(/^Amount lent/, "350000");
    type(/^Interest rate/, "12");
    type(/^Receipts/, "24");
    fireEvent.change(screen.getByLabelText(/^Money lent/), { target: { value: "out-1" } });
    expect(screen.getByText(/no new bank entry is made/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Save loan & reconcile receipt 1/ }));
    await vi.waitFor(() => expect(setUp).toHaveBeenCalled());
    expect(setUp.mock.calls[0][0]).toMatchObject({ disbursal_txn_id: "out-1", reconcile_txn_id: "t1" });
  });

  it("an EMI below the month's interest cannot be saved", () => {
    render(<LoanGivenReceiptSection transaction={{ ...line1, credit: 3000 }} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Set up loan given/ }));
    type(/^Borrower/, "Vinod Hem Raj");
    type(/^Amount lent/, "350000");
    type(/^Interest rate/, "12");
    type(/^Receipts/, "24");
    expect(screen.getByText(/does not cover the first month's interest/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Save loan/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("R-2340 — the next receipt is suggested", () => {
  it("next month's ₹16,476 line → receipt 2 of Vinod Hem Raj, split ₹13,106 + ₹3,370, reconciled on Save", async () => {
    loans = [buildLoan(vinodRow, [receipt1 as never], "2026-11-05")];
    render(<LoanGivenReceiptSection transaction={line2} onDone={vi.fn()} />);
    expect(screen.getByText(/Looks like receipt 2 of the loan you gave/)).toBeTruthy();
    const split = screen.getByTestId("loan-given-split");
    expect(split.textContent).toContain("13,106");
    expect(split.textContent).toContain("3,370");
    fireEvent.click(screen.getByRole("button", { name: /Reconcile as receipt 2/ }));
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledWith({ txnId: "t2", loanId: "loan-v", interestPart: null }));
  });

  it("is not shown to a role that cannot see loans given", () => {
    role = "sales";
    const { container } = render(<LoanGivenReceiptSection transaction={line1} onDone={vi.fn()} />);
    expect(container.textContent).toBe("");
  });
});
