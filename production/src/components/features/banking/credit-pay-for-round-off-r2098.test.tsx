// @vitest-environment jsdom
/* R-2098 follow-up: on "Several quotes / invoices", a round-off only when every ticked item is
   settled in full. A + B with B part-paid and a small gap → no round-off, Save locked with the
   reason; all items in full with ₹≤50 short → round-off, saved. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { OpenItem } from "@/lib/banking/credit-pay-for";
import type { BankTransactionRow } from "@/lib/queries/bank";

const state = vi.hoisted(() => ({ items: [] as unknown[], split: vi.fn() }));

vi.mock("@/lib/queries/customer-payers", () => ({
  usePayerMemory: () => ({ payers: [], ownNames: [] }),
  useSetBankLinePayer: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/queries/bank", () => ({ useOpenInvoicesForCreditMatch: () => ({ data: [] }) }));
vi.mock("@/lib/queries/bank-credit-pay-for", () => ({
  useBankCreditOpenItems: (id: string | null) => ({ data: id ? state.items : undefined, isLoading: false }),
  usePayItemFromBankCredit: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
  state.items = []; state.split.mockReset();
  state.split.mockResolvedValue({ kind: "split", parts: [], amount: 0, round_off: 0 });
});

const customers = [{ id: "c1", name: "R818 Test Co", country: "India" }];
const txnOf = (credit: number) =>
  ({ id: "t1", bank_account_id: "b1", txn_date: "2026-10-24", description: "NEFT R818", debit: 0, credit, reference: "UTR9" } as unknown as BankTransactionRow);
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

describe("R-2098 round-off only when every item is settled in full", () => {
  it("A full + B part with a ₹40 gap → no round-off, Save locked, never 'settled in full'", () => {
    state.items = [inv(1, 590), inv(2, 1180)];
    open(1000);
    tick("INV-1"); tick("INV-2");
    fireEvent.change(screen.getByLabelText("Amount on INV-2"), { target: { value: "450" } });
    expect(bar()).toContain("Left −₹40");
    expect(bar()).not.toContain("settled in full");
    expect(bar()).toContain("paid in part");
    expect((screen.getByRole("button", { name: /Record on 2 items/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("then lowering B to the money (₹410) saves with no round-off — B stays part-due", async () => {
    state.items = [inv(1, 590), inv(2, 1180)];
    open(1000);
    tick("INV-1"); tick("INV-2");
    fireEvent.change(screen.getByLabelText("Amount on INV-2"), { target: { value: "410" } });
    expect(bar()).toContain("Left ₹0");
    fireEvent.click(screen.getByRole("button", { name: /Record on 2 items/ }));
    await waitFor(() => expect(state.split).toHaveBeenCalledTimes(1));
    expect(state.split.mock.calls[0][0]).toMatchObject({ rest: null, items: [{ invoice_id: "INV-1", amount: 590 }, { invoice_id: "INV-2", amount: 410 }] });
  });

  it("A full + B part with ₹10 extra → no round-off button, kept as advance", () => {
    state.items = [inv(1, 590), inv(2, 1180)];
    open(1000);
    tick("INV-1"); tick("INV-2");
    fireEvent.change(screen.getByLabelText("Amount on INV-2"), { target: { value: "400" } });
    expect(screen.queryByRole("button", { name: /as round-off/ })).toBeNull();
    expect(bar()).toContain("kept as the customer's advance");
  });

  it("A + B both in full, ₹20 short → round-off, saved", async () => {
    state.items = [inv(1, 590), inv(2, 1180)];
    open(1750);
    tick("INV-1"); tick("INV-2");
    expect(bar()).toContain("every item is settled in full");
    fireEvent.click(screen.getByRole("button", { name: /Record on 2 items/ }));
    await waitFor(() => expect(state.split).toHaveBeenCalledTimes(1));
    expect(state.split.mock.calls[0][0].rest).toBe("round_off");
  });
});
