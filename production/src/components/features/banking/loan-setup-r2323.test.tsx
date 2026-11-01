// @vitest-environment jsdom
/* R-2323 — Banking → Reconcile → Loan / EMI on an EMI line with no loan in the books
   (staging, 31 Oct: "Bike EMI ₹19,054 monthly", Bajaj, Tata Capital — nothing to match).
   Owner example: ₹19,054 NACH from Bajaj Finance; the loan still owes ₹2,50,000 at 11% with 14
   EMIs left. "Set up this loan" → the form starts from the line (lender from the narration, EMI =
   the line, first EMI = the line's date); EMI 1 shows ₹16,762 principal + ₹2,292 interest; Save
   sets the loan up AND reconciles this line as EMI 1 in one step. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const setUp = vi.fn();
vi.mock("@/lib/queries/emi", () => ({
  useEmiMatches: () => ({ data: [], isLoading: false }),
  useEmiPurchases: () => ({ data: [], isLoading: false }),
  useEmiSchedule: () => ({ data: { rows: [], payments: [] }, isLoading: false }),
  useReconcileDebitToEmi: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/banking/loan-setup-query", () => ({
  useSetUpEmiLoan: () => ({ mutateAsync: setUp, isPending: false }),
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

const txn = { id: "t1", debit: 19054, txn_date: "2026-10-05", bank_account_id: "acc-1", description: "NACH DR BAJAJ FINANCE LTD" };
const type = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

afterEach(cleanup);
beforeEach(() => { setUp.mockReset(); setUp.mockResolvedValue({ purchase_id: "p9" }); });

describe("R-2323 — Set up this loan from an EMI line", () => {
  it("no loan matches: 'Set up this loan' is offered on the line itself", () => {
    render(<EmiRepaymentSection transaction={txn} onDone={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Set up this loan/ })).toBeTruthy();
  });

  it("starts from the line, shows EMI 1's split, saves the loan and reconciles this line as EMI 1", async () => {
    const done = vi.fn();
    render(<EmiRepaymentSection transaction={txn} onDone={done} />);
    fireEvent.click(screen.getByRole("button", { name: /Set up this loan/ }));

    expect((screen.getByLabelText(/^Lender/) as HTMLInputElement).value).toBe("Bajaj Finance");
    expect((screen.getByLabelText(/^EMI \(₹\)/) as HTMLInputElement).value).toBe("19054");
    expect((screen.getByLabelText(/^First EMI date/) as HTMLInputElement).value).toBe("2026-10-05");

    type(/^Amount still owed/, "250000");
    type(/^Interest rate/, "11");
    type(/^EMIs left/, "14");

    const split = screen.getByTestId("loan-setup-first-emi");
    expect(split.textContent).toContain("₹16,762");
    expect(split.textContent).toContain("₹2,292");
    // The bank's EMI is kept; the standard one is only shown.
    expect(screen.getByText(/standard EMI would be ₹19,109/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Save loan & reconcile EMI 1/ }));
    await vi.waitFor(() => expect(done).toHaveBeenCalled());
    const p = setUp.mock.calls[0][0];
    expect(p).toMatchObject({
      lender: "Bajaj Finance", principal: 250000, interest_rate: 11, account_id: null, received_on: null, reconcile_txn_id: "t1",
    });
    expect(p.schedule).toHaveLength(14);
    expect(p.schedule[0]).toEqual({ seq: 1, due_on: "2026-10-05", emi: 19054, principal: 16762, interest: 2292, balance_after: 233238 });
  });

  it("the loan money came into a bank account: that account and date are sent", async () => {
    render(<EmiRepaymentSection transaction={txn} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Set up this loan/ }));
    type(/^Amount still owed/, "250000");
    type(/^Interest rate/, "11");
    type(/^EMIs left/, "14");
    fireEvent.change(screen.getByLabelText(/^Loan money came into/), { target: { value: "acc-2" } });
    const save = screen.getByRole("button", { name: /Save loan & reconcile EMI 1/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByText("Enter the date the loan money came in")).toBeTruthy();
    type(/^Received on/, "2026-09-05");
    fireEvent.click(save);
    await vi.waitFor(() => expect(setUp).toHaveBeenCalled());
    expect(setUp.mock.calls[0][0]).toMatchObject({ account_id: "acc-2", received_on: "2026-09-05", reconcile_txn_id: "t1" });
  });

  it("a first EMI date other than this line's: the loan is saved, this line is not reconciled", async () => {
    render(<EmiRepaymentSection transaction={txn} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Set up this loan/ }));
    type(/^Amount still owed/, "250000");
    type(/^Interest rate/, "11");
    type(/^EMIs left/, "14");
    type(/^First EMI date/, "2026-09-05");
    fireEvent.click(screen.getByRole("button", { name: /^Save loan$/ }));
    await vi.waitFor(() => expect(setUp).toHaveBeenCalled());
    expect(setUp.mock.calls[0][0]).toMatchObject({ reconcile_txn_id: null });
  });
});
