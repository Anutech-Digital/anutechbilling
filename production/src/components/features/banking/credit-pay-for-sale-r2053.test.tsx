// @vitest-environment jsdom
/* R-2053 — Reconcile → "A new sale" → Starter, Annual, 10 seats. (1) Type 3000 in the price box →
   Monthly flex shows 250 ₹/user/month → Annual shows 3000 again; untouched shows 3,240. (2) Under
   Create subscription (start 23-10-2026): "1 year: 23-10-2026 to 22-10-2027 · renews 23-10-2027";
   the Renews on box stays 23-10-2027; with parts the paid-up line stays and no date is said twice. */
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
  useSplitFromBankCredit: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/queries/items", () => ({
  useItems: () => ({
    data: [{
      id: "GW-ST", name: "Google Workspace Business Starter", vendor: "google", msrp: 270, wholesale: 110,
      item_type: "subscription", is_active: true, prices: { annual: { msrp: 270, wholesale: 110 }, monthly: { msrp: 325, wholesale: 132 } },
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

function newSale(credit: number) {
  render(<CreditPayForSection transaction={txn(credit)} customers={customers} onDone={() => {}} />);
  fireEvent.change(screen.getByLabelText("Customer who paid"), { target: { value: "c1" } });
  fireEvent.click(screen.getByRole("button", { name: "A new sale (no quote yet)" }));
  fireEvent.change(screen.getByLabelText("Add a product"), { target: { value: "GW-ST" } });
  fireEvent.change(screen.getByLabelText("Seats"), { target: { value: "10" } });
}
const price = (unit: string) => (screen.getByLabelText(`Unit price ${unit}`) as HTMLInputElement).value;

describe("R-2053 (1) a typed price is kept when Commitment changes", () => {
  it("type 3000 → Monthly flex keeps 3000 and asks (R-2178) → Annual 3000 ₹/user/year; saved as typed", () => {
    newSale(35400);
    fireEvent.change(screen.getByLabelText("Unit price ₹/user/year"), { target: { value: "3000" } });
    fireEvent.change(screen.getByLabelText("Commitment"), { target: { value: "monthly" } });
    expect(price("₹/user/month")).toBe("3000");
    expect(screen.getByRole("button", { name: "Use catalogue ₹325/user/month" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Commitment"), { target: { value: "annual_yearly" } });
    expect(screen.queryByRole("group", { name: "Typed price check" })).toBeNull();
    expect(price("₹/user/year")).toBe("3000");
    fireEvent.click(screen.getByRole("button", { name: "Record sale & reconcile ₹35,400" }));
    expect(state.sale.mock.calls[0][0].lines[0]).toMatchObject({ rate: 3000, cycle: "annual_yearly", qty: 10 });
  });
  it("untouched: 3,240 a year → 325 a month (catalogue) → 3,240", () => {
    newSale(38232);
    expect(price("₹/user/year")).toBe("3240");
    fireEvent.change(screen.getByLabelText("Commitment"), { target: { value: "monthly" } });
    expect(price("₹/user/month")).toBe("325");
    fireEvent.change(screen.getByLabelText("Commitment"), { target: { value: "annual_yearly" } });
    expect(price("₹/user/year")).toBe("3240");
  });
});

/* R-2178 — staging 31 Oct (LOOK BOOK FLY): 7 × ₹1,800/user/year typed, Commitment switched
   One-time → Monthly flex → Annual: the quote came out ₹1,78,416 (₹21,600 a user) instead of ₹14,868. */
describe("R-2178 a typed price never changes silently on a Commitment switch", () => {
  it("owner's path: 7 × 1800, Annual → One-time → Monthly flex → Annual saves ₹1,800 and ₹14,868", () => {
    newSale(14868);
    fireEvent.change(screen.getByLabelText("Seats"), { target: { value: "7" } });
    fireEvent.change(screen.getByLabelText("Unit price ₹/user/year"), { target: { value: "1800" } });
    for (const c of ["one_time", "monthly", "annual_yearly"]) {
      fireEvent.change(screen.getByLabelText("Commitment"), { target: { value: c } });
    }
    expect(price("₹/user/year")).toBe("1800");
    expect(screen.getByText(/Total ₹14,868/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Record sale & reconcile ₹14,868" }));
    expect(state.sale.mock.calls[0][0].lines[0]).toMatchObject({ rate: 1800, cycle: "annual_yearly", qty: 7 });
  });
  it("typed under Monthly flex then Annual: kept, asked, Save waits; the Annual catalogue rate is a button and Undo puts it back", () => {
    newSale(14868);
    fireEvent.change(screen.getByLabelText("Commitment"), { target: { value: "monthly" } });
    fireEvent.change(screen.getByLabelText("Unit price ₹/user/month"), { target: { value: "1800" } });
    fireEvent.change(screen.getByLabelText("Commitment"), { target: { value: "annual_yearly" } });
    expect(price("₹/user/year")).toBe("1800");
    expect(screen.getByText("₹1,800 was typed as ₹/user/month. The line is now ₹/user/year — the number was kept.")).toBeTruthy();
    const save = screen.getByRole("button", { name: /Record sale & reconcile/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /21,600/ })).toBeNull();   // never ×12 on a catalogue line
    fireEvent.click(screen.getByRole("button", { name: "Use catalogue ₹3,240/user/year" }));
    expect(price("₹/user/year")).toBe("3240");
    fireEvent.click(screen.getByRole("button", { name: "Undo — back to ₹1,800" }));
    expect(price("₹/user/year")).toBe("1800");
    fireEvent.click(screen.getByRole("button", { name: "Keep ₹1,800/user/year" }));
    expect(screen.queryByRole("group", { name: "Typed price check" })).toBeNull();
    expect((screen.getByRole("button", { name: /Record sale & reconcile/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});

/* R-2178 OWNER RULE (Pardeep 31 Oct): under Annual, PAYMENT FREQUENCY never changes the rate — only
   the amount per bill. The unit price box keeps its number and says its unit (₹/user/year). */
describe("R-2178 owner rule — payment frequency never changes the rate", () => {
  it.each(["half_yearly", "quarterly", "monthly"])("Annual 10 × ₹3,240/user/year → %s: same price, same unit, same total", (freq) => {
    newSale(38232);
    fireEvent.change(screen.getByLabelText("Payment frequency"), { target: { value: freq } });
    expect(price("₹/user/year")).toBe("3240");
    expect(screen.getByText(/Total ₹38,232/)).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Typed price check" })).toBeNull();
  });
  it("a TYPED annual price survives a frequency change too", () => {
    newSale(14868);
    fireEvent.change(screen.getByLabelText("Seats"), { target: { value: "7" } });
    fireEvent.change(screen.getByLabelText("Unit price ₹/user/year"), { target: { value: "1800" } });
    fireEvent.change(screen.getByLabelText("Payment frequency"), { target: { value: "quarterly" } });
    expect(price("₹/user/year")).toBe("1800");
    expect(screen.getByText(/Total ₹14,868/)).toBeTruthy();
  });
});

describe("R-2053 (2) the term under Create subscription", () => {
  it("start 23-10-2026 → '1 year: 23-10-2026 to 22-10-2027 · renews 23-10-2027'; Renews on box unchanged; nothing saved differently", () => {
    newSale(38232);
    expect((screen.getByLabelText("Subscription renewal date") as HTMLInputElement).value).toBe("2027-10-23");
    expect(screen.getByText("1 year: 23-10-2026 to 22-10-2027 · renews 23-10-2027")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Record sale & reconcile ₹38,232" }));
    expect(state.sale.mock.calls[0][0]).toMatchObject({ subStart: "2026-10-23", subRenewal: null });
  });
  it("Monthly flex → '1 month: 23-10-2026 to 22-11-2026 · renews 23-11-2026'", () => {
    newSale(3835);
    fireEvent.change(screen.getByLabelText("Commitment"), { target: { value: "monthly" } });
    expect(screen.getByText("1 month: 23-10-2026 to 22-11-2026 · renews 23-11-2026")).toBeTruthy();
  });
  it("Half-yearly → the term line and the paid-up line; no date said twice; the old hint is gone", () => {
    newSale(19116);
    fireEvent.change(screen.getByLabelText("Payment frequency"), { target: { value: "half_yearly" } });
    expect(screen.getByText("1 year: 23-10-2026 to 22-10-2027 · renews 23-10-2027")).toBeTruthy();
    expect(screen.getByText("Paid up to 22-04-2027 · next bill ₹19,116 on 23 Apr 2027.")).toBeTruthy();
    expect(screen.queryByText(/Renews on is the end of the 1-year commitment/)).toBeNull();
    for (const d of ["23-10-2026", "22-10-2027", "23-10-2027", "22-04-2027", "23 Apr 2027"]) {
      expect(screen.getAllByText(new RegExp(d))).toHaveLength(1);
    }
  });
});
