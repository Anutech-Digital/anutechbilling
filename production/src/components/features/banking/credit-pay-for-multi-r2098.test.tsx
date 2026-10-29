// @vitest-environment jsdom
/* R-2098 — Reconcile → Customer → "Several quotes / invoices": tick several open items (each gets
   its due), watch allocated / bank / left, the rest is advance or (≤ ₹50) round-off; ONE save. The
   single-item choice is unchanged. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { OpenItem } from "@/lib/banking/credit-pay-for";
import type { BankTransactionRow } from "@/lib/queries/bank";

const state = vi.hoisted(() => ({ items: [] as unknown[], pay: vi.fn(), split: vi.fn() }));

vi.mock("@/lib/queries/customer-payers", () => ({
  usePayerMemory: () => ({ payers: [], ownNames: [] }),
  useSetBankLinePayer: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/queries/bank", () => ({ useOpenInvoicesForCreditMatch: () => ({ data: [] }) }));
vi.mock("@/lib/queries/bank-credit-pay-for", () => ({
  useBankCreditOpenItems: (id: string | null) => ({ data: id ? state.items : undefined, isLoading: false }),
  usePayItemFromBankCredit: () => ({ mutateAsync: state.pay, isPending: false }),
  useNewSaleFromBankCredit: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAdvanceFromBankCredit: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRelinkOneOffSale: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSplitFromBankCredit: () => ({ mutateAsync: state.split, isPending: false }),
}));
vi.mock("@/lib/queries/items", () => ({ useItems: () => ({ data: [] }) }));
vi.mock("@/lib/compliance/gst-registration-query", () => ({ useGstRegistration: () => ({ data: { saved: null } }) }));

import { CreditPayForSection } from "./credit-pay-for-section";

afterEach(cleanup);
beforeEach(() => {
  state.items = []; state.pay.mockReset(); state.split.mockReset();
  state.split.mockResolvedValue({ kind: "split", parts: [], subscriptions: [], amount: 0, round_off: 0 });
});

const customers = [{ id: "c1", name: "I-XL Systems", country: "India" }];
const txnOf = (credit: number) =>
  ({ id: "t1", bank_account_id: "b1", txn_date: "2026-10-20", description: "NEFT CR-IXL-UTR1", debit: 0, credit, reference: "UTR1" } as unknown as BankTransactionRow);
const inv = (n: number, due: number): OpenItem => ({
  kind: "invoice", quote_id: `Q-${n}`, invoice_id: `INV-${n}`, doc_date: "2026-10-10", amount_due: due, taxable_value: Math.round(due / 1.18),
  makes_subscription: false, subscription_id: null, plan: null, seats: null, renewal_date: null, lines: [],
});

const open = (credit: number) => {
  render(<CreditPayForSection transaction={txnOf(credit)} customers={customers} onDone={() => {}} />);
  fireEvent.change(screen.getByLabelText("Customer who paid"), { target: { value: "c1" } });
  fireEvent.click(screen.getByRole("button", { name: "Several quotes / invoices" }));
};
const tick = (doc: string) => fireEvent.click(screen.getByRole("checkbox", { name: `Pay ${doc}` }));
const bar = () => screen.getByRole("status", { name: "Allocation" }).textContent ?? "";

describe("R-2098 one bank line → several items", () => {
  it("3 invoices, exact: the bar says ₹0 left and ONE save sends all three", async () => {
    state.items = [inv(1, 3906), inv(2, 3906), inv(3, 3906)];
    open(11718);
    tick("INV-1"); tick("INV-2"); tick("INV-3");
    expect(bar()).toContain("Allocated ₹11,718");
    expect(bar()).toContain("Bank ₹11,718");
    expect(bar()).toContain("Left ₹0");
    fireEvent.click(screen.getByRole("button", { name: "Record on 3 items & reconcile ₹11,718" }));
    await waitFor(() => expect(state.split).toHaveBeenCalledTimes(1));
    expect(state.split.mock.calls[0][0]).toMatchObject({
      transactionId: "t1", customerId: "c1", sale: null, rest: null,
      items: [{ invoice_id: "INV-1", amount: 3906 }, { invoice_id: "INV-2", amount: 3906 }, { invoice_id: "INV-3", amount: 3906 }],
    });
    expect(state.pay).not.toHaveBeenCalled();
  });

  it("8 invoices + ₹346 left → kept as advance", async () => {
    state.items = Array.from({ length: 8 }, (_, i) => inv(i + 1, i === 7 ? 17364 : 14000));
    open(115710);
    for (let i = 1; i <= 8; i++) tick(`INV-${i}`);
    expect(bar()).toContain("Left ₹346");
    expect(screen.getByText("₹346 left over — kept as the customer's advance credit, used on their next bill.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Record on 8 items & reconcile ₹1,15,710" }));
    await waitFor(() => expect(state.split).toHaveBeenCalledTimes(1));
    expect(state.split.mock.calls[0][0].rest).toBe("advance");
    expect(state.split.mock.calls[0][0].items).toHaveLength(8);
  });

  it("₹48 short → written off as round-off", async () => {
    state.items = [inv(1, 16284)];
    open(16236);
    tick("INV-1");
    expect(bar()).toContain("Left −₹48");
    expect(screen.getByText(/₹48 less came in than these items — written off as round-off/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Record on 1 item & reconcile ₹16,236" }));
    await waitFor(() => expect(state.split).toHaveBeenCalledTimes(1));
    expect(state.split.mock.calls[0][0].rest).toBe("round_off");
  });

  it("over-allocation is refused: Save locked with the reason", () => {
    state.items = [inv(1, 11800)];
    open(11000);
    tick("INV-1");
    expect(screen.getByText(/Allocated ₹800 more than came in/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Record on 1 item & reconcile ₹11,000" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("an amount over its due is flagged and blocks Save; a part amount is fine", () => {
    state.items = [inv(1, 5000), inv(2, 6000)];
    open(11000);
    tick("INV-1"); tick("INV-2");
    fireEvent.change(screen.getByLabelText("Amount on INV-1"), { target: { value: "5001" } });
    expect(screen.getByText("More than the ₹5,000 due")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Record on 2 items/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Amount on INV-1"), { target: { value: "4000" } });
    expect(bar()).toContain("Left ₹1,000");
    expect((screen.getByRole("button", { name: /Record on 2 items/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a small extra can be written off instead of kept", async () => {
    state.items = [inv(1, 5900)];
    open(5902);
    tick("INV-1");
    fireEvent.click(screen.getByRole("button", { name: "Write off ₹2 as round-off" }));
    fireEvent.click(screen.getByRole("button", { name: "Record on 1 item & reconcile ₹5,902" }));
    await waitFor(() => expect(state.split).toHaveBeenCalledTimes(1));
    expect(state.split.mock.calls[0][0].rest).toBe("round_off");
  });

  it("the single-item choice is unchanged: radio list, its own save", async () => {
    state.pay.mockResolvedValue({ kind: "invoice", quote_id: "Q-1", invoice_id: "INV-1", subscriptions: [], amount: 3906, tds_amount: 0, outstanding: 0 });
    state.items = [inv(1, 3906)];
    render(<CreditPayForSection transaction={txnOf(3906)} customers={customers} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("Customer who paid"), { target: { value: "c1" } });
    fireEvent.click(screen.getByRole("button", { name: "An open quote / invoice" }));
    expect(screen.getByRole("radio", { checked: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Record ₹3,906 on INV-1 & reconcile" }));
    await waitFor(() => expect(state.pay).toHaveBeenCalledTimes(1));
    expect(state.split).not.toHaveBeenCalled();
  });

  it("not offered on a relink of an old one-off sale", () => {
    render(<CreditPayForSection transaction={txnOf(1000)} customers={customers} pickedCustomerId="c1" onDone={() => {}}
      relink={{ txn_id: "t1" } as never} />);
    expect(screen.queryByRole("button", { name: "Several quotes / invoices" })).toBeNull();
  });
});
