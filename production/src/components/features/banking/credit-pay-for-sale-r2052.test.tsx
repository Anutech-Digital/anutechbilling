// @vitest-environment jsdom
/* R-2052 — Pardeep 28 Oct (localhost): Reconcile → "A new sale" → Starter, Annual, 10 seats,
   Payment Half-yearly, start 23-10-2026. "Renews on" stays 23-10-2027 (the 1-year commitment) and
   under it one line says how far the money pays: "Paid up to 22-04-2027 · next bill … on 23 Apr
   2027". The next bill is said once — the old "Next 1 bill …" line under the totals is merged in. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { BankTransactionRow } from "@/lib/queries/bank";

const state = vi.hoisted(() => ({ sale: vi.fn() }));

vi.mock("@/lib/queries/customer-payers", () => ({
  usePayerMemory: () => ({ payers: [], ownNames: [] }),
  useSetBankLinePayer: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/queries/bank", () => ({ useOpenInvoicesForCreditMatch: () => ({ data: [] }) }));
vi.mock("@/lib/queries/bank-credit-pay-for", () => ({
  useBankCreditOpenItems: () => ({ data: [], isLoading: false }),
  usePayItemFromBankCredit: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useNewSaleFromBankCredit: () => ({ mutateAsync: state.sale, isPending: false }),
  useAdvanceFromBankCredit: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRelinkOneOffSale: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/queries/items", () => ({
  useItems: () => ({
    data: [{
      id: "GW-ST", name: "Google Workspace Business Starter", vendor: "google", msrp: 270, wholesale: 110,
      item_type: "subscription", is_active: true, prices: { annual: { msrp: 270, wholesale: 110 } },
    }],
  }),
}));
vi.mock("@/lib/compliance/gst-registration-query", () => ({ useGstRegistration: () => ({ data: { saved: null } }) }));

import { CreditPayForSection } from "./credit-pay-for-section";

afterEach(cleanup);
beforeEach(() => { state.sale.mockReset(); });

const customers = [{ id: "c1", name: "Acme Traders", country: "India" }];
const txn = (credit: number) => ({
  id: "t1", bank_account_id: "b1", txn_date: "2026-10-23", description: "NEFT CR-ACME-UTR1", debit: 0, credit, reference: "UTR1",
} as unknown as BankTransactionRow);

function newSale(credit: number, payment: string) {
  render(<CreditPayForSection transaction={txn(credit)} customers={customers} onDone={() => {}} />);
  fireEvent.change(screen.getByLabelText("Customer who paid"), { target: { value: "c1" } });
  fireEvent.click(screen.getByRole("button", { name: "A new sale (no quote yet)" }));
  fireEvent.change(screen.getByLabelText("Add a product"), { target: { value: "GW-ST" } });
  fireEvent.change(screen.getByLabelText("Seats"), { target: { value: "10" } });
  fireEvent.change(screen.getByLabelText("Payment"), { target: { value: payment } });
}
const HINT = "Renews on is the end of the 1-year commitment; parts are billed on their dates.";

describe("R-2052 Create subscription: Renews on stays a year, paid-up line beside it", () => {
  it("owner's example: Half-yearly from 23-10-2026 → Renews on 23-10-2027, 'Paid up to 22-04-2027 · next bill … on 23 Apr 2027', said once", () => {
    newSale(19116, "half_yearly");
    expect((screen.getByLabelText("Subscription start date") as HTMLInputElement).value).toBe("2026-10-23");
    expect((screen.getByLabelText("Subscription renewal date") as HTMLInputElement).value).toBe("2027-10-23");
    expect(screen.getByText("Paid up to 22-04-2027 · next bill ₹19,116 on 23 Apr 2027.")).toBeTruthy();
    expect(screen.getByText(HINT)).toBeTruthy();
    expect(screen.queryByText(/Next 1 bill/)).toBeNull();               // one fact, one place
    expect(screen.getAllByText(/23 Apr 2027/)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Record sale & reconcile ₹19,116" }));
    expect(state.sale.mock.calls[0][0]).toMatchObject({ billingCycle: "half_yearly", subStart: "2026-10-23", subRenewal: null });
  });

  it("Quarterly → paid up to 22-01-2027; Annual — 1 payment → the line goes away", () => {
    newSale(9558, "quarterly");
    expect(screen.getByText(/^Paid up to 22-01-2027 · next bill ₹9,558 on 23 Jan 2027/)).toBeTruthy();
    expect((screen.getByLabelText("Subscription renewal date") as HTMLInputElement).value).toBe("2027-10-23");
    fireEvent.change(screen.getByLabelText("Payment"), { target: { value: "yearly" } });
    expect(screen.queryByText(/Paid up to/)).toBeNull();
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it("extra money that pays the next quarter in full → paid up to 22-04-2027", () => {
    newSale(9558 * 2, "quarterly");
    expect(screen.getByText(/^Paid up to 22-04-2027 · next bill ₹9,558 on 23 Apr 2027/)).toBeTruthy();
  });

  it("extra money short of a quarter → paid up to the first quarter only", () => {
    newSale(9558 + 5000, "quarterly");
    expect(screen.getByText(/^Paid up to 22-01-2027 · next bill ₹9,558 on 23 Jan 2027/)).toBeTruthy();
  });

  it("Create subscription unticked → no paid-up line; the later bills stay under the totals", () => {
    newSale(9558, "quarterly");
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.queryByText(/Paid up to/)).toBeNull();
    expect(screen.getByText(/^Next 3 bills ₹9,558 each/)).toBeTruthy();
  });
});
