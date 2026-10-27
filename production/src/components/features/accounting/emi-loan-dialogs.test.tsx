// @vitest-environment jsdom
/* R-1864 — "Bought on EMI / loan". Owner example: a Dell laptop ₹1,20,000, ₹20,000 down from HDFC,
   Bajaj Finance ₹1,00,000 at 14% for 12 EMIs, ₹500 processing fee → EMI ₹8,979 shown before saving,
   and ONE save carries the asset, the loan, the fee and the 12-row schedule (principal = ₹1,00,000).
   From a bank line of ₹20,500 the down payment is the line minus the fee. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mutateAsync = vi.fn();
vi.mock("@/lib/queries/bank", () => ({
  useBankAccounts: () => ({ data: [{ id: "acc-1", name: "HDFC Current", is_active: true, account_type: "current" }] }),
}));
vi.mock("@/lib/queries/emi", () => ({
  useRecordEmiAssetPurchase: () => ({ mutateAsync, isPending: false }),
  useEmiSchedule: () => ({ data: { rows: [], payments: [] }, isLoading: false }),
  usePayNextEmi: () => ({ mutate: vi.fn(), isPending: false }),
  usePrepayEmiLoan: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUndoEmiPayment: () => ({ mutate: vi.fn(), isPending: false }),
  EMI_STATUS_LABEL: { linked: "Paid · in bank", paid_by_hand: "Paid · awaiting statement", due: "Due", overdue: "Overdue" },
}));

import { EmiPurchaseDialog } from "./emi-loan-dialogs";

const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

afterEach(cleanup);
beforeEach(() => { mutateAsync.mockReset(); mutateAsync.mockResolvedValue("p1"); });

describe("R-1864 Bought on EMI / loan", () => {
  it("laptop: EMI ₹8,979 shown, one save with asset + loan + fee + 12-row schedule", async () => {
    const close = vi.fn();
    render(<EmiPurchaseDialog onClose={close} />);
    type("Item", "Dell laptop");
    type(/^Cost/, "120000");
    type("Purchase date", "2026-10-05");
    type(/^Down payment/, "20000");
    type("Lender", "Bajaj Finance");
    type(/^Interest rate/, "14");
    type("Number of EMIs", "12");
    type(/^Processing fee/, "500");
    expect((screen.getByLabelText(/^EMI \(₹\)/) as HTMLInputElement).value).toBe("8979");
    expect(screen.getByText(/The last EMI is ₹8,977/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Record purchase & loan" }));
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    const arg = mutateAsync.mock.calls[0][0];
    expect(arg).toMatchObject({
      name: "Dell laptop", block: "computers", cost: 120000, purchasedOn: "2026-10-05", downPayment: 20000,
      accountId: "acc-1", downBankTxnId: null, lender: "Bajaj Finance", interestRate: 14, noCost: false, processingFee: 500,
    });
    expect(arg.schedule).toHaveLength(12);
    expect(arg.schedule[0]).toMatchObject({ dueOn: "2026-11-05", emi: 8979, principal: 7812, interest: 1167 });
    expect(arg.schedule.reduce((s: number, r: { principal: number }) => s + r.principal, 0)).toBe(100000);
  });

  it("no-cost EMI: no interest, the rate box is off", async () => {
    render(<EmiPurchaseDialog onClose={vi.fn()} />);
    type("Item", "Phone");
    type(/^Cost/, "30000");
    type("Lender", "Bajaj Finance");
    fireEvent.click(screen.getByLabelText(/No-cost EMI/));
    type("Number of EMIs", "7");
    expect((screen.getByLabelText(/^Interest rate/) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Record purchase & loan" }));
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    const arg = mutateAsync.mock.calls[0][0];
    expect(arg.noCost).toBe(true);
    expect(arg.schedule.every((r: { interest: number }) => r.interest === 0)).toBe(true);
  });

  it("from a ₹20,500 bank line: down payment = line − fee, the line is the cash", async () => {
    render(<EmiPurchaseDialog onClose={vi.fn()} fromTxn={{ id: "t1", amount: 20500, date: "2026-10-05", accountId: "acc-1", description: "CROMA" }} />);
    type("Item", "Dell laptop");
    type(/^Cost/, "120000");
    type("Lender", "Bajaj Finance");
    type(/^Interest rate/, "14");
    type(/^Processing fee/, "500");
    expect(screen.getByText(/Down payment/).textContent).toContain("₹20,000");
    fireEvent.click(screen.getByRole("button", { name: "Record purchase & loan" }));
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ downPayment: 20000, downBankTxnId: "t1", accountId: null });
  });

  it("missing rate: the save button stays off and says why", () => {
    render(<EmiPurchaseDialog onClose={vi.fn()} />);
    type("Item", "Dell laptop");
    type(/^Cost/, "120000");
    type("Lender", "Bajaj Finance");
    expect((screen.getByRole("button", { name: "Record purchase & loan" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Enter the interest rate, or tick No-cost EMI/)).toBeTruthy();
  });
});
