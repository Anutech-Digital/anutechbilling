// @vitest-environment jsdom
/* R-1678b — independent review BLOCK (5 Nov): a ₹ credit on a USD invoice must not hide TDS, a gateway fee
   or an advance as an exchange difference. The Reconcile sheet pre-selects "Not exchange — book in ₹" for a
   gateway settlement, offers no exchange difference to a customer in India, and shows the gap %. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { BankTransactionRow } from "@/lib/queries/bank";
import type { OpenItem } from "@/lib/banking/credit-pay-for";

const state = vi.hoisted(() => ({ pay: vi.fn(), split: vi.fn(), items: [] as unknown[] }));

vi.mock("@/lib/queries/customer-payers", () => ({
  usePayerMemory: () => ({ payers: [], ownNames: [] }),
  useSetBankLinePayer: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/queries/bank", () => ({ useOpenInvoicesForCreditMatch: () => ({ data: [] }) }));
vi.mock("@/lib/queries/bank-credit-pay-for", () => ({
  useBankCreditOpenItems: () => ({ data: state.items, isLoading: false }),
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
  state.pay.mockReset(); state.pay.mockResolvedValue({ kind: "one_off", payment_id: "p1", subscriptions: [] });
  state.split.mockReset(); state.split.mockResolvedValue({ kind: "split", payment_id: "p1", parts: [] });
});

const usdInvoice = (o: Partial<OpenItem> = {}): OpenItem => ({
  kind: "invoice", quote_id: "Q-PEAK", invoice_id: "INV-PEAK", doc_date: "2026-08-26", amount_due: 13206, taxable_value: 13206,
  makes_subscription: false, subscription_id: null, plan: null, seats: null, renewal_date: null, lines: [],
  currency: "USD", fx_rate: 95.007, ...o,
});
const customers = [{ id: "us", name: "Peak Performance Hackers", country: "United States" }, { id: "in", name: "Acme India Pvt Ltd", country: "India" }];
const txn = (credit: number, description: string) => ({
  id: "t1", bank_account_id: "b1", txn_date: "2026-09-03", description, debit: 0, credit, reference: "UTR1",
} as unknown as BankTransactionRow);

function pick(credit: number, description: string, customerId: string) {
  render(<CreditPayForSection transaction={txn(credit, description)} customers={customers} onDone={() => {}} />);
  fireEvent.change(screen.getByLabelText("Customer who paid"), { target: { value: customerId } });
  fireEvent.click(screen.getByRole("button", { name: /An open quote \/ invoice/ }));
  fireEvent.click(screen.getByRole("radio", { name: /INV-PEAK/ }));
}

describe("R-1678b exchange difference only when it is one", () => {
  it("Peak (overseas, NEFT ₹12,976 for ₹13,206): exchange difference pre-selected, gap % shown", () => {
    state.items = [usdInvoice()];
    pick(12976, "NEFT CR-CITI0000001-PEAK PERFORMANCE HACKERS", "us");
    expect(screen.getByRole("button", { name: /Exchange difference — settle in full/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/₹230 exchange loss .* The ₹ gap is 1.74% of the due\./)).toBeTruthy();
  });

  it("a Razorpay settlement line pre-selects 'Not exchange — book in ₹' (the gap is the gateway fee)", () => {
    state.items = [usdInvoice()];
    pick(12976, "RAZORPAY SOFTWARE PVT LTD SETTLEMENT", "us");
    expect(screen.getByRole("button", { name: /Not exchange — book in ₹/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Record ₹12,976 on INV-PEAK & reconcile" }));
    expect(state.split).not.toHaveBeenCalled();
    expect(state.pay.mock.calls[0][0]).toMatchObject({ invoiceId: "INV-PEAK", fx: null });
  });

  it("a customer in India: no exchange difference offered — the usual ₹ amount check (TDS / part)", () => {
    state.items = [usdInvoice({ amount_due: 100000, taxable_value: 100000, fx_rate: 100 })];
    pick(98000, "NEFT CR ACME INDIA", "in");
    expect(screen.queryByRole("button", { name: /Exchange difference — settle in full/ })).toBeNull();
    expect(screen.queryByText(/exchange loss/)).toBeNull();
    expect(screen.getByText(/TDS deducted/)).toBeTruthy();
  });

  it("an over-payment in ₹ is not an exchange gain — no exchange note; the extra goes the usual way (advance)", () => {
    state.items = [usdInvoice()];
    pick(14000, "NEFT CR PEAK", "us");
    expect(screen.queryByText(/exchange gain/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Exchange difference — settle in full/ })).toBeNull();
  });
});
