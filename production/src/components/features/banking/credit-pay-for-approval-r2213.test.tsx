// @vitest-environment jsdom
/* R-2213 — July reconcile on staging (R-2094): a Manage-seats quote priced below cost, still
   waiting for the owner's approval, was picked under "An open quote / invoice" and Save booked the
   money. The sheet now shows "Needs approval" on it, keeps Save locked with the DB's own reason,
   and offers "Open approval" (the quote page). An approved quote saves as before. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { OpenItem } from "@/lib/banking/credit-pay-for";
import type { BankTransactionRow } from "@/lib/queries/bank";
import { belowCostRefusal } from "@/lib/quotes/payment-approval";

const state = vi.hoisted(() => ({ items: [] as unknown[], pay: vi.fn() }));

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
  useSplitFromBankCredit: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/queries/items", () => ({ useItems: () => ({ data: [] }) }));
vi.mock("@/lib/compliance/gst-registration-query", () => ({ useGstRegistration: () => ({ data: { saved: null } }) }));

import { CreditPayForSection } from "./credit-pay-for-section";

afterEach(cleanup);
beforeEach(() => { state.items = []; state.pay.mockReset(); });

const customers = [{ id: "c1", name: "Banbury Exports", country: "India" }];
const txn = { id: "t1", bank_account_id: "b1", txn_date: "2026-07-15", description: "NEFT CR-BANBURY-UTR1", debit: 0, credit: 1770, reference: "UTR1" } as unknown as BankTransactionRow;
const seats = (o: Partial<OpenItem>): OpenItem => ({
  kind: "add_seats", quote_id: "Q-A378-27-0429", invoice_id: null, doc_date: "2026-07-10", amount_due: 1770, taxable_value: 1500,
  makes_subscription: false, subscription_id: "s1", plan: "Google Workspace Business Standard", seats: 3, renewal_date: null, lines: [], ...o,
});

const openItems = () => {
  fireEvent.change(screen.getByLabelText("Customer who paid"), { target: { value: "c1" } });
  fireEvent.click(screen.getByRole("button", { name: "An open quote / invoice" }));
};

describe("R-2213 reconcile: below-cost quote waiting for approval", () => {
  it("shows 'Needs approval', locks Save with the reason, and links to the quote's approval", () => {
    state.items = [seats({ approval_block: belowCostRefusal("Q-A378-27-0429") })];
    render(<CreditPayForSection transaction={txn} customers={customers} onDone={() => {}} />);
    openItems();
    const row = screen.getByRole("radio", { checked: true });
    expect(row.textContent).toContain("Needs approval");
    expect(row.textContent).not.toContain("Sent");
    const save = screen.getByRole("button", { name: "Record ₹1,770 on Q-A378-27-0429 & reconcile" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain(
      "This quote is below cost and waits for the owner's approval. Approve it first (Quotes → Q-A378-27-0429 → Approve), then record the payment.",
    );
    expect(screen.getByRole("link", { name: "Open approval" }).getAttribute("href")).toBe("/quotes/Q-A378-27-0429");
    fireEvent.click(save);
    expect(state.pay).not.toHaveBeenCalled();
  });

  it("after approval (no block) the same quote saves as before", () => {
    state.items = [seats({ approval_block: null })];
    render(<CreditPayForSection transaction={txn} customers={customers} onDone={() => {}} />);
    openItems();
    expect(screen.getByRole("radio", { checked: true }).textContent).not.toContain("Needs approval");
    expect(screen.queryByRole("link", { name: "Open approval" })).toBeNull();
    expect((screen.getByRole("button", { name: "Record ₹1,770 on Q-A378-27-0429 & reconcile" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
