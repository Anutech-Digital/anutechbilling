// @vitest-environment jsdom
/* R-1864 — Banking → Reconcile, a money-out line that is an EMI. Owner examples:
   1. ₹8,979 NACH from Bajaj Finance on the due date → "Looks like an EMI", EMI 1 split shown as
      ₹7,812 principal + ₹1,167 interest, reconciled with exactly that split.
   2. ₹9,029 (EMI 2 + ₹50 late fee) → the extra ₹50 is a late fee (expense) by default; the split
      sent is 7,903 + 1,076 + 50 charges, principal unchanged.
   3. ₹20,500 down-payment line → "Match down payment" (the manual line is replaced, seq 0). */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { EmiMatch } from "@/lib/queries/emi";

const mutateAsync = vi.fn();
let matches: EmiMatch[] = [];
vi.mock("@/lib/queries/emi", () => ({
  useEmiMatches: () => ({ data: matches, isLoading: false }),
  useEmiPurchases: () => ({ data: [{ id: "p1", name: "Dell laptop", status: "active", outstanding: 92188, interest_rate: 14, no_cost: false }], isLoading: false }),
  useEmiSchedule: () => ({ data: { rows: [], payments: [] }, isLoading: false }),
  useReconcileDebitToEmi: () => ({ mutateAsync, isPending: false }),
}));
vi.mock("@/components/features/accounting/emi-loan-dialogs", () => ({
  EmiPurchaseDialog: () => <div>purchase dialog</div>,
  EmiPrepayDialog: () => <div>prepay dialog</div>,
}));

import { EmiRepaymentSection } from "./emi-repayment-section";

const txn = (debit: number) => ({ id: "t1", debit, txn_date: "2026-12-07", bank_account_id: "acc-1", description: "NACH DR BAJAJ FINANCE" });
const m = (over: Partial<EmiMatch>): EmiMatch => ({
  purchase_id: "p1", purchase_name: "Dell laptop", lender: "Bajaj Finance", seq: 1, due_on: "2026-11-05", kind: "instalment",
  expected: 8979, principal: 7812, interest: 1167, difference: 0, confidence: "exact", ...over,
});

afterEach(cleanup);
beforeEach(() => { mutateAsync.mockReset(); mutateAsync.mockResolvedValue({ kind: "emi" }); matches = []; });

describe("R-1864 reconcile — EMI / loan repayment", () => {
  it("an exact EMI: opens itself, shows the schedule split and books exactly that", async () => {
    matches = [m({})];
    const done = vi.fn();
    render(<EmiRepaymentSection transaction={txn(8979)} onDone={done} />);
    expect(screen.getByText(/Looks like an EMI/)).toBeTruthy();
    const split = screen.getByTestId("emi-split");
    expect(split.textContent).toContain("₹7,812");
    expect(split.textContent).toContain("₹1,167");
    fireEvent.click(screen.getByRole("button", { name: /Reconcile as EMI 1/ }));
    await vi.waitFor(() => expect(done).toHaveBeenCalled());
    expect(mutateAsync).toHaveBeenCalledWith({
      txnId: "t1", purchaseId: "p1", seq: 1, principal: 7812, interest: 1167, charges: 0, newSchedule: null,
    });
  });

  it("₹50 more than the EMI: a late fee by default — principal stays as scheduled", async () => {
    matches = [m({ seq: 2, due_on: "2026-12-05", principal: 7903, interest: 1076, difference: 50, confidence: "low" })];
    render(<EmiRepaymentSection transaction={txn(9029)} onDone={vi.fn()} />);
    // Opens by itself: a late-fee line is a weak match, but still an EMI.
    expect(screen.getByText(/Looks like an EMI/)).toBeTruthy();
    expect(screen.getByText(/Late fee \/ bounce charge/)).toBeTruthy();
    expect(screen.getByTestId("emi-split").textContent).toContain("₹50");
    fireEvent.click(screen.getByRole("button", { name: /Reconcile as EMI 2/ }));
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ seq: 2, principal: 7903, interest: 1076, charges: 50, newSchedule: null });
  });

  it("the down payment line: matched to the purchase (seq 0)", async () => {
    matches = [m({ seq: 0, kind: "down_payment", expected: 20500, principal: 0, interest: 0, due_on: "2026-10-05", confidence: "high" })];
    render(<EmiRepaymentSection transaction={txn(20500)} onDone={vi.fn()} />);
    expect(screen.getByText(/Looks like the down payment/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Match down payment ₹20,500/ }));
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync).toHaveBeenCalledWith({ txnId: "t1", purchaseId: "p1", seq: 0 });
  });

  it("no match: stays closed and never calls the whole EMI an expense", () => {
    render(<EmiRepaymentSection transaction={txn(5000)} onDone={vi.fn()} />);
    expect(screen.getByText(/never the whole amount as an expense/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Reconcile as EMI/ })).toBeNull();
  });
});
