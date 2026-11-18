// @vitest-environment jsdom
/* R-2920 — Banking → a money-IN line → Loan / EMI → "A receipt on a loan you gave?".
   The owner's line: NEFT CR KAPIL DEV ₹3,50,000 on 21 Feb 2026 pays off the ₹3,49,000 left on his
   ₹9,99,000 loan AND his separate ₹1,000 loan. The loans are tick boxes; both of Kapil Dev's are
   ticked with ₹3,49,000 + ₹1,000, "Bank ₹3,50,000 = ₹3,50,000 ✓", and Save books both in ONE call.
   Save stays off while the amounts do not add up to the line or one is more than that loan owes.
   A line that names nobody ticks nothing (was: the first loan in the list, "suman rani"). */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { buildLoan, loanGivenReceiptRpc, type LoanGivenRow } from "@/lib/queries/loans-given";
import type { FooterSave } from "./reconcile-who-tiles";

const reconcile = vi.fn();
let loans: unknown[] = [];
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "owner" } }) }));
vi.mock("@/lib/queries/bank", () => ({ useBankAccounts: () => ({ data: [] }) }));
vi.mock("@/lib/queries/loans-given", async (orig) => ({
  ...(await orig<typeof import("@/lib/queries/loans-given")>()),
  useLoansGiven: () => ({ data: loans, isLoading: false }),
  useSetUpLoanGiven: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useReconcileCreditToLoanGiven: () => ({ mutateAsync: reconcile, isPending: false }),
  useLoanGivenDisbursalLines: () => ({ data: [], isLoading: false }),
}));

import { LoanGivenReceiptSection } from "./loan-given-receipt-section";

const row = (id: string, name: string, principal: number, givenOn: string) => ({
  id, tenant_id: "t", borrower_name: name, borrower_type: "person", customer_id: null, vendor_id: null,
  principal, given_on: givenOn, interest_rate: 0, repayment_plan: "one_shot", due_on: null, instalments: null,
  emi_amount: null, paid_from_account_id: null, bank_txn_id: null, notes: null, status: "open", closed_on: null,
  created_by: null, created_at: "", updated_at: "",
}) as unknown as LoanGivenRow;
const earlier = {
  id: "r0", tenant_id: "t", loan_id: "k-big", repaid_on: "2026-01-10", amount: 650000, principal_part: 650000, interest_part: 0,
  mode: "bank", reference: null, bank_account_id: "acc-1", bank_txn_id: "t0", notes: null, created_by: null, created_at: "",
};
const TODAY = "2026-11-18";
const book = () => [
  buildLoan(row("suman", "suman rani", 200000, "2026-02-01"), [], TODAY),
  buildLoan(row("k-small", "Kapil Dev", 1000, "2026-01-05"), [], TODAY),
  buildLoan(row("k-big", "Kapil Dev", 999000, "2025-12-15"), [earlier as never], TODAY),
];
const kapilLine = { id: "t9", credit: 350000, txn_date: "2026-02-21", description: "NEFT CR-HDFC0000123-KAPIL DEV-REF 5521" };
const namelessLine = { ...kapilLine, description: "CASH DEPOSIT BY SELF" };

const boxes = () => screen.getAllByRole("checkbox") as HTMLInputElement[];
const box = (name: RegExp) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
const amountOf = (name: RegExp) => screen.getByRole("spinbutton", { name }) as HTMLInputElement;
const saveBtn = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

afterEach(cleanup);
beforeEach(() => { reconcile.mockReset(); reconcile.mockResolvedValue({ receipts: [], loans: 2, principal: 350000, interest: 0 }); loans = book(); });

describe("R-2920 — one bank receipt across two loans given", () => {
  it("Kapil Dev ₹3,50,000: his two loans are listed first and ticked, ₹3,49,000 + ₹1,000 tally, Save books both in one call", async () => {
    const onDone = vi.fn();
    render(<LoanGivenReceiptSection transaction={kapilLine} onDone={onDone} />);
    // His loans first (oldest first), then the others.
    expect(boxes().map((b) => b.checked)).toEqual([true, true, false]);
    expect(box(/Receipt 2 · Kapil Dev/).checked).toBe(true);
    expect(box(/Receipt 1 · Kapil Dev/).checked).toBe(true);
    expect(box(/suman rani/).checked).toBe(false);
    expect(amountOf(/Amount for Kapil Dev, receipt 2/).value).toBe("349000");
    expect(amountOf(/Amount for Kapil Dev, receipt 1/).value).toBe("1000");
    expect(screen.getByTestId("loan-given-tally").textContent).toBe("Bank ₹3,50,000 = ₹3,50,000 ✓");
    const btn = saveBtn(/Reconcile to 2 loans/);
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledWith({
      txnId: "t9",
      parts: [
        { loanId: "k-big", amount: 349000, interestPart: 0 },
        { loanId: "k-small", amount: 1000, interestPart: 0 },
      ],
    }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("amounts that do not add up to the bank line keep Save off and say how much is left", () => {
    render(<LoanGivenReceiptSection transaction={kapilLine} onDone={vi.fn()} />);
    fireEvent.change(amountOf(/Amount for Kapil Dev, receipt 2/), { target: { value: "348000" } });
    // The other loan cannot take more than its ₹1,000.
    expect(screen.getByTestId("loan-given-tally").textContent).toBe("Bank ₹3,50,000 ≠ ₹3,49,000 — ₹1,000 still to place");
    expect(saveBtn(/Reconcile to 2 loans/).disabled).toBe(true);
    fireEvent.click(saveBtn(/Reconcile to 2 loans/));
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("an emptied amount counts as ₹0 — the row asks for an amount and Save stays off", () => {
    render(<LoanGivenReceiptSection transaction={kapilLine} onDone={vi.fn()} />);
    fireEvent.change(amountOf(/Amount for Kapil Dev, receipt 1/), { target: { value: "" } });
    expect(screen.getByText(/Enter a whole-rupee amount, or untick this loan/)).toBeTruthy();
    expect(screen.getByTestId("loan-given-tally").textContent).toBe("Bank ₹3,50,000 ≠ ₹3,49,000 — ₹1,000 still to place");
    expect(saveBtn(/Reconcile to 2 loans/).disabled).toBe(true);
  });

  it("R-2921: the amount box steps in whole rupees, and paise (999.5) are refused — never rounded to ₹1,000", () => {
    render(<LoanGivenReceiptSection transaction={kapilLine} onDone={vi.fn()} />);
    expect(amountOf(/Amount for Kapil Dev, receipt 1/).step).toBe("1");
    fireEvent.change(amountOf(/Amount for Kapil Dev, receipt 1/), { target: { value: "999.5" } });
    expect(screen.getByText(/Enter a whole-rupee amount, or untick this loan/)).toBeTruthy();
    expect(screen.getByTestId("loan-given-tally").textContent).toBe("Bank ₹3,50,000 ≠ ₹3,49,000 — ₹1,000 still to place");
    expect(saveBtn(/Reconcile to 2 loans/).disabled).toBe(true);
  });

  it("a part more than that loan owes keeps Save off even when the amounts tally", () => {
    render(<LoanGivenReceiptSection transaction={kapilLine} onDone={vi.fn()} />);
    fireEvent.change(amountOf(/Amount for Kapil Dev, receipt 2/), { target: { value: "349500" } });
    expect(amountOf(/Amount for Kapil Dev, receipt 1/).value).toBe("500");
    expect(screen.getByTestId("loan-given-tally").textContent).toBe("Bank ₹3,50,000 = ₹3,50,000 ✓");
    expect(screen.getByText(/More than is owed — at most ₹3,49,000 can come in on this loan/)).toBeTruthy();
    expect(saveBtn(/Reconcile to 2 loans/).disabled).toBe(true);
  });

  it("a line that names nobody ticks NOTHING; one loan alone is 'more than is owed', the second tick makes it save", async () => {
    render(<LoanGivenReceiptSection transaction={namelessLine} onDone={vi.fn()} />);
    expect(boxes().map((b) => b.checked)).toEqual([false, false, false]);
    expect(saveBtn(/Pick the loan/).disabled).toBe(true);

    fireEvent.click(box(/Receipt 2 · Kapil Dev/));
    expect(screen.getByText(/More than is owed — at most ₹3,49,000 can come in on this loan/)).toBeTruthy();
    expect(screen.getByText(/tick that loan too/)).toBeTruthy();
    expect(saveBtn(/Reconcile as receipt 2/).disabled).toBe(true);
    expect(screen.queryByTestId("loan-given-tally")).toBeNull();

    fireEvent.click(box(/Receipt 1 · Kapil Dev/));
    expect(screen.getByTestId("loan-given-tally").textContent).toBe("Bank ₹3,50,000 = ₹3,50,000 ✓");
    expect(screen.queryByText(/More than is owed/)).toBeNull();
    fireEvent.click(saveBtn(/Reconcile to 2 loans/));
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    expect(reconcile.mock.calls[0][0].parts).toHaveLength(2);
  });

  it("unticking back to one loan is the one-loan flow: same label, same one-loan call", async () => {
    render(<LoanGivenReceiptSection transaction={{ ...kapilLine, credit: 349000 }} onDone={vi.fn()} />);
    // ₹3,49,000 is covered by the older loan alone → only that one is ticked.
    expect(boxes().map((b) => b.checked)).toEqual([true, false, false]);
    expect(screen.getByTestId("loan-given-split").textContent).toContain("3,49,000");
    expect(screen.getByText(/This receipt clears the loan/)).toBeTruthy();
    fireEvent.click(saveBtn(/Reconcile as receipt 2/));
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledWith({ txnId: "t9", loanId: "k-big", interestPart: 0 }));
  });

  it("in the Reconcile sheet the footer Save follows the same rule", async () => {
    let last: FooterSave | null = null;
    const report = (s: FooterSave | null) => { last = s; };
    render(<LoanGivenReceiptSection transaction={kapilLine} onDone={vi.fn()} onFooterSave={report} />);
    await vi.waitFor(() => expect(last).toMatchObject({ label: "Reconcile to 2 loans", disabled: false }));
    expect(screen.queryByRole("button", { name: /Reconcile to 2 loans/ })).toBeNull();   // no second Save in the body
    fireEvent.change(amountOf(/Amount for Kapil Dev, receipt 1/), { target: { value: "400" } });
    await vi.waitFor(() => expect(last).toMatchObject({ label: "Reconcile to 2 loans", disabled: true }));
    fireEvent.change(amountOf(/Amount for Kapil Dev, receipt 1/), { target: { value: "1000" } });
    await vi.waitFor(() => expect(last).toMatchObject({ disabled: false }));
  });
});

describe("R-2920 — which RPC the save calls", () => {
  it("two or more loans → reconcile_bank_credit_to_loans_given with every part, one call", () => {
    expect(loanGivenReceiptRpc({ txnId: "t9", parts: [
      { loanId: "k-big", amount: 349000, interestPart: 0 }, { loanId: "emi", amount: 1000, interestPart: null },
    ] })).toEqual({
      fn: "reconcile_bank_credit_to_loans_given",
      args: { p_txn_id: "t9", p_parts: [
        { loan_id: "k-big", amount: 349000, interest_part: 0 }, { loan_id: "emi", amount: 1000, interest_part: null },
      ] },
    });
  });
  it("one loan → R-2340's reconcile_bank_credit_to_loan_given, unchanged", () => {
    expect(loanGivenReceiptRpc({ txnId: "t2", loanId: "loan-v", interestPart: null })).toEqual({
      fn: "reconcile_bank_credit_to_loan_given", args: { p_txn_id: "t2", p_loan_id: "loan-v", p_interest_part: null },
    });
  });
});
