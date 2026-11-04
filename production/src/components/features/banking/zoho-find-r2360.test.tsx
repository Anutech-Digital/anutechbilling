// @vitest-environment jsdom
/* R-2360 — Find in Zoho part 2: the one Zoho invoice number goes with the Save (kept on the app
   invoice), the result says so, several Zoho invoices keep none, and "Create customer" starts the
   Add-customer form with Zoho's name + GSTIN. Same owner example and fakes as R-2359's test. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { BankTransactionRow } from "@/lib/queries/bank";

const state = vi.hoisted(() => ({ sale: vi.fn(), item: vi.fn(), advance: vi.fn(), split: vi.fn() }));

vi.mock("@/lib/queries/customer-payers", () => ({
  usePayerMemory: () => ({ payers: [], ownNames: [] }),
  useSetBankLinePayer: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/queries/bank", () => ({ useOpenInvoicesForCreditMatch: () => ({ data: [] }) }));
vi.mock("@/lib/queries/bank-credit-pay-for", () => ({
  useBankCreditOpenItems: () => ({ data: [], isLoading: false }),
  usePayItemFromBankCredit: () => ({ mutateAsync: state.item, isPending: false }),
  useNewSaleFromBankCredit: () => ({ mutateAsync: state.sale, isPending: false }),
  useAdvanceFromBankCredit: () => ({ mutateAsync: state.advance, isPending: false }),
  useRelinkOneOffSale: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSplitFromBankCredit: () => ({ mutateAsync: state.split, isPending: false }),
}));
vi.mock("@/lib/queries/items", () => ({
  useItems: () => ({
    data: [{
      id: "GW-ST", name: "Google Workspace Business Starter", sku: "GWS-BS", vendor: "google", msrp: 270, wholesale: 110,
      item_type: "subscription", is_active: true,
      prices: { annual: { msrp: 270, wholesale: 110 }, monthly: { msrp: 325, wholesale: 132 } },
    }],
  }),
}));
vi.mock("@/lib/compliance/gst-registration-query", () => ({ useGstRegistration: () => ({ data: { saved: null } }) }));

import { CreditPayForSection } from "./credit-pay-for-section";

const customers = [
  { id: "supreme", name: "Supreme Media and Studios Pvt Ltd", country: "India", gstin: null },
  { id: "c2", name: "Bharat Steel", country: "India" },
];
const txn = {
  id: "33333333-0000-4000-8000-000000000613", bank_account_id: "b1", txn_date: "2026-07-21",
  description: "NEFT CR-IDFB0080202-SUPREME MEDIA AND STUDIOS P-IDFB6202M2890149", debit: 0, credit: 27081, reference: null,
} as unknown as BankTransactionRow;

const MATCH = {
  by: "utr",
  payment: { zohoId: "p1", number: "7801", date: "2026-07-21", amount: 27081, reference: "IDFB6202M2890149", customerZohoId: "c1", customerName: "SUPREME MEDIA & STUDIOS PRIVATE LIMITED" },
  customer: { zohoId: "c1", name: "SUPREME MEDIA & STUDIOS PRIVATE LIMITED", gstin: "07AAACS0000A1Z5" },
  invoices: [{
    zohoId: "i1", number: "INV/26-27/0613", date: "2026-07-21", amountApplied: 27081, total: 27081,
    lines: [{ invoiceNumber: "INV/26-27/0613", name: "Google Workspace Business Starter", sku: "GWS-BS", qty: 9, rate: 2550, itemTotal: 22950, start: "2026-07-21", end: "2027-07-20", months: 12, domain: "gptalents.in" }],
  }],
  moreInvoices: [],
};

let answer: unknown;
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(answer), { status: 200 }));

beforeEach(() => {
  Object.values(state).forEach((f) => f.mockReset());
  fetchMock.mockClear();
  answer = { ok: true, result: { kind: "match", match: MATCH } };
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const findInZoho = () => fireEvent.click(screen.getByRole("button", { name: "Find in Zoho" }));

const SAVED = { kind: "new", quote_id: "Q-1", invoice_id: "INV-1", invoice_issued: "INV-1", payment_id: "p", receipt_voucher_no: null, amount: 27081, tds_amount: 0, outstanding: 0, is_fully_paid: true, overpaid_credit: 0, renewal_rolled_forward: false, subscription_skipped: false, already_recorded: false, new_quote: true, subscriptions: [] };

describe("R-2360 the Zoho invoice number on the app invoice", () => {
  it("Save sends the Zoho number; the result says which invoice keeps it", async () => {
    render(<CreditPayForSection transaction={txn} customers={customers} onDone={() => {}} />);
    findInZoho();
    await screen.findByLabelText("Zoho match");
    expect(screen.getByText(/kept on the app invoice when you save the new sale/)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "A new sale (no quote yet)" }).getAttribute("aria-pressed")).toBe("true"));
    state.sale.mockResolvedValue({ ...SAVED, external_number: "INV/26-27/0613", external_number_saved: true });
    fireEvent.click(screen.getByRole("button", { name: "Record sale & reconcile ₹27,081" }));
    await waitFor(() => expect(state.sale).toHaveBeenCalledTimes(1));
    expect(state.sale.mock.calls[0][0]).toMatchObject({ externalNumber: "INV/26-27/0613" });
    expect(await screen.findByText("Zoho invoice INV/26-27/0613 is kept on INV-1.")).toBeTruthy();
  });

  it("a Zoho payment applied to two invoices → no number is kept (only shown)", async () => {
    answer = { ok: true, result: { kind: "match", match: { ...MATCH, invoices: [MATCH.invoices[0], { ...MATCH.invoices[0], zohoId: "i2", number: "INV/26-27/0614", lines: [] }] } } };
    render(<CreditPayForSection transaction={txn} customers={customers} onDone={() => {}} />);
    findInZoho();
    await screen.findByLabelText("Zoho match");
    expect(screen.getByText(/several, so none is kept on the app invoice/)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "A new sale (no quote yet)" }).getAttribute("aria-pressed")).toBe("true"));
    state.sale.mockResolvedValue(SAVED);
    fireEvent.click(screen.getByRole("button", { name: "Record sale & reconcile ₹27,081" }));
    await waitFor(() => expect(state.sale).toHaveBeenCalledTimes(1));
    expect(state.sale.mock.calls[0][0].externalNumber).toBeNull();
  });

  it("Zoho's customer not in the app → Create customer passes Zoho's name and GSTIN to the form", async () => {
    const onNewCustomer = vi.fn();
    render(<CreditPayForSection transaction={txn} customers={[customers[1]]} onDone={() => {}} onNewCustomer={onNewCustomer} />);
    findInZoho();
    fireEvent.click(await screen.findByRole("button", { name: "Create customer" }));
    expect(onNewCustomer).toHaveBeenCalledWith({ name: "SUPREME MEDIA & STUDIOS PRIVATE LIMITED", gstin: "07AAACS0000A1Z5" });
  });
});
