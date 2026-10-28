// @vitest-environment jsdom
/* R-2050 — Pardeep 28 Oct (localhost): Banking → Reconcile → "A new sale (no quote yet)" →
   E2E Google Workspace Business Starter, Annual, 10 seats. It said "Unit price ₹/user/month" = 136
   and "10 × ₹136/user/month × 12 = ₹16,320 a year". Annual now asks ₹/user/YEAR, prefilled at the
   list floor ₹3,240 (the E2E row's ₹136 is stale). Monthly keeps ₹/user/month. */
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
      id: "E2E-ST", name: "E2E Google Workspace Business Starter", vendor: "google", msrp: 136, wholesale: 110,
      item_type: "subscription", is_active: true, prices: {},
    }],
  }),
}));
vi.mock("@/lib/compliance/gst-registration-query", () => ({ useGstRegistration: () => ({ data: { saved: null } }) }));

import { CreditPayForSection } from "./credit-pay-for-section";

afterEach(cleanup);
beforeEach(() => { state.sale.mockReset(); });

const customers = [{ id: "c1", name: "Acme Traders", country: "India" }];
const txn = (credit: number) => ({
  id: "t1", bank_account_id: "b1", txn_date: "2026-10-28", description: "NEFT CR-ACME-UTR1", debit: 0, credit, reference: "UTR1",
} as unknown as BankTransactionRow);

function newSale(credit: number) {
  render(<CreditPayForSection transaction={txn(credit)} customers={customers} onDone={() => {}} />);
  fireEvent.change(screen.getByLabelText("Customer who paid"), { target: { value: "c1" } });
  fireEvent.click(screen.getByRole("button", { name: "A new sale (no quote yet)" }));
  fireEvent.change(screen.getByLabelText("Add a product"), { target: { value: "E2E-ST" } });
  fireEvent.change(screen.getByLabelText("Seats"), { target: { value: "10" } });
}

describe("R-2050 Annual commitment asks the price per user per year", () => {
  it("owner's example: Annual, 10 seats → 3240, '10 × ₹3,240/user/year = ₹32,400 a year', Total ₹38,232; saves 3,240/seat/year", () => {
    newSale(38232);
    expect((screen.getByLabelText("Commitment") as HTMLSelectElement).value).toBe("annual_yearly");
    expect(screen.queryByLabelText("Unit price ₹/user/month")).toBeNull();
    expect((screen.getByLabelText("Unit price ₹/user/year") as HTMLInputElement).value).toBe("3240");
    expect(screen.getByText("10 × ₹3,240/user/year = ₹32,400 a year")).toBeTruthy();
    expect(screen.getByText(/Taxable ₹32,400 · GST 18% ₹5,832/)).toBeTruthy();
    expect(screen.getByText(/Total ₹38,232/)).toBeTruthy();
    expect(screen.getByText(/₹38,232 received = ₹38,232 due/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Record sale & reconcile ₹38,232" }));
    expect(state.sale.mock.calls[0][0].lines[0]).toMatchObject({ itemId: "E2E-ST", qty: 10, rate: 3240, cycle: "annual_yearly" });
  });

  it("a typed yearly deal price is kept as typed (not × 12)", () => {
    newSale(35400);
    fireEvent.change(screen.getByLabelText("Unit price ₹/user/year"), { target: { value: "3000" } });
    expect(screen.getByText("10 × ₹3,000/user/year = ₹30,000 a year")).toBeTruthy();
    expect(screen.getByText(/₹35,400 received = ₹35,400 due/)).toBeTruthy();
  });

  it("Monthly commitment goes back to ₹/user/month; Annual again shows the yearly price", () => {
    newSale(3186);
    fireEvent.change(screen.getByLabelText("Commitment"), { target: { value: "monthly" } });
    expect(screen.queryByLabelText("Unit price ₹/user/year")).toBeNull();
    expect((screen.getByLabelText("Unit price ₹/user/month") as HTMLInputElement).value).toBe("270");
    expect(screen.getByText("10 × ₹270/user/month = ₹2,700 a month")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Commitment"), { target: { value: "annual_yearly" } });
    expect((screen.getByLabelText("Unit price ₹/user/year") as HTMLInputElement).value).toBe("3240");
  });
});
