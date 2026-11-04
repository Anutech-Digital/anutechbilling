// @vitest-environment jsdom
/* R-2466 — Chrome check 4 Nov (localhost): Banking → Reconcile → "An open quote / invoice" said
   "<customer> has nothing open" for customers whose open invoices have no quote. Now a Zoho opening
   invoice is listed and paid here, and a USD invoice paid by its USD inward remittance books through
   R-2427's forex path (the sheet says the forex gain; no "kept as advance credit"). */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { BankTransactionRow } from "@/lib/queries/bank";
import type { OpenItem } from "@/lib/banking/credit-pay-for";

const state = vi.hoisted(() => ({ pay: vi.fn(), items: [] as unknown[] }));

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
  useSplitFromBankCredit: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/queries/items", () => ({ useItems: () => ({ data: [] }) }));
vi.mock("@/lib/compliance/gst-registration-query", () => ({ useGstRegistration: () => ({ data: { saved: null } }) }));

import { CreditPayForSection } from "./credit-pay-for-section";

afterEach(cleanup);
beforeEach(() => { state.pay.mockReset(); state.pay.mockResolvedValue({ kind: "opening", payment_id: "p1", subscriptions: [] }); });

const item = (o: Partial<OpenItem>): OpenItem => ({
  kind: "invoice", quote_id: null, invoice_id: null, doc_date: "2026-09-25", amount_due: 0, taxable_value: 0,
  makes_subscription: false, subscription_id: null, plan: null, seats: null, renewal_date: null, lines: [],
  currency: "INR", fx_rate: null, ...o,
});
const customers = [{ id: "c1", name: "SCN Zero Ref Traders", country: "India" }, { id: "c2", name: "SCN Timbergloss Inc", country: "United States" }];
const txn = (credit: number, description: string) => ({
  id: "t1", bank_account_id: "b1", txn_date: "2026-11-01", description, debit: 0, credit, reference: "000000000000000",
} as unknown as BankTransactionRow);

function openItems(credit: number, description: string, customerId: string) {
  render(<CreditPayForSection transaction={txn(credit, description)} customers={customers} onDone={() => {}} />);
  fireEvent.change(screen.getByLabelText("Customer who paid"), { target: { value: customerId } });
  fireEvent.click(screen.getByRole("button", { name: /An open quote \/ invoice/ }));
}

describe("R-2466 quote-less invoices in 'An open quote / invoice'", () => {
  it("a Zoho opening invoice is listed and paid here (owner's zero-ref ₹5,000 line)", () => {
    state.items = [item({ kind: "opening", invoice_id: "INV-OPN-1", amount_due: 11800 })];
    openItems(5000, "NEFT CR-000000000000000-SCN ZERO REF TRADERS-PART 1", "c1");
    expect(screen.queryByText(/has nothing open/)).toBeNull();
    expect(screen.getByText("Opening invoice (from Zoho)")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /INV-OPN-1/ }));
    fireEvent.click(screen.getByRole("button", { name: "Record ₹5,000 on INV-OPN-1 & reconcile" }));
    expect(state.pay).toHaveBeenCalledTimes(1);
    expect(state.pay.mock.calls[0][0]).toMatchObject({ transactionId: "t1", invoiceId: "INV-OPN-1", quoteId: null, fx: null });
  });

  it("more than an opening invoice's due → Save locked with the way forward (no customer credit on it)", () => {
    state.items = [item({ kind: "opening", invoice_id: "INV-OPN-2", amount_due: 1800 })];
    openItems(5000, "NEFT CR SCN ZERO REF", "c1");
    fireEvent.click(screen.getByRole("radio", { name: /INV-OPN-2/ }));
    expect(screen.getByText(/INV-OPN-2 is last year's invoice from Zoho with ₹1,800 due — it takes no more/)).toBeTruthy();
    expect(screen.queryByText(/kept as the customer's advance credit/)).toBeNull();
    expect((screen.getByRole("button", { name: "Record ₹5,000 on INV-OPN-2 & reconcile" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("owner's USD example: INV-SCN-USD-1 $2,000 @ ₹84 + 'USD2000.0@88.5' ₹1,77,000 → forex path, ₹9,000 gain", () => {
    state.items = [item({ kind: "invoice", quote_id: "Q-SCN-USD-1", invoice_id: "INV-SCN-USD-1", amount_due: 168000, taxable_value: 168000, currency: "USD", fx_rate: 84 })];
    openItems(177000, "INW 041126I0SCN0000022 USD2000.0@88.5 SCN TIMBERGLOSS INC", "c2");
    fireEvent.click(screen.getByRole("radio", { name: /INV-SCN-USD-1/ }));
    expect(screen.getByText(/Export receipt \$2,000 @ ₹88.50 settles INV-SCN-USD-1 in full .* ₹9,000 forex gain/)).toBeTruthy();
    expect(screen.queryByText(/kept as the customer's advance credit/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Record ₹1,77,000 on INV-SCN-USD-1 & reconcile" }));
    expect(state.pay.mock.calls[0][0]).toMatchObject({
      invoiceId: "INV-SCN-USD-1", tdsAmount: 0,
      fx: { currency: "USD", rate: 88.5, foreignAmount: 2000, invoiceRate: 84, forex: -9000, bankCharges: 0 },
    });
  });

  it("review: 'Several quotes / invoices' with a USD invoice ticked → Save locked with the reason", () => {
    state.items = [item({ kind: "invoice", quote_id: "Q-SCN-USD-1", invoice_id: "INV-SCN-USD-1", amount_due: 168000, currency: "USD", fx_rate: 84 })];
    render(<CreditPayForSection transaction={txn(177000, "INW 041126I0SCN0000022 USD2000.0@88.5")} customers={customers} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("Customer who paid"), { target: { value: "c2" } });
    fireEvent.click(screen.getByRole("button", { name: /Several quotes \/ invoices/ }));
    fireEvent.click(screen.getByLabelText("Pay INV-SCN-USD-1"));
    expect(screen.getByText(/INV-SCN-USD-1 is in USD — pay it on its own/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Record on 1 item & reconcile/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a USD invoice with a ₹ narration is not booked in ₹", () => {
    state.items = [item({ kind: "invoice", quote_id: "Q-SCN-USD-1", invoice_id: "INV-SCN-USD-1", amount_due: 168000, currency: "USD", fx_rate: 84 })];
    openItems(177000, "NEFT CR TIMBERGLOSS", "c2");
    fireEvent.click(screen.getByRole("radio", { name: /INV-SCN-USD-1/ }));
    expect(screen.getByText(/INV-SCN-USD-1 is in USD, but this bank line's narration has no USD amount and rate/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Record ₹1,77,000 on INV-SCN-USD-1 & reconcile" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
