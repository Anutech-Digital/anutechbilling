// @vitest-environment jsdom
/* R-2518 — Find in Zoho with a payment applied to TWO Zoho invoices: one app sale per invoice (fakes as R-2360's test). */
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

/* R-2518 — staging (a client company): one UPI ₹6,294 paid Zoho INV/26-27/0516 ₹3,243 (15 × 180 + 1 × 48) and
   INV/26-27/0517 ₹3,051 (14 × 180 + 1 × 66). Find in Zoho → Save books one app sale per Zoho invoice,
   each with its own lines and Zoho number, in ONE split call (never one merged sale). */
const line = (no: string, name: string, qty: number, rate: number) =>
  ({ invoiceNumber: no, name, sku: null, qty, rate, itemTotal: qty * rate, start: null, end: null, months: 0, domain: null });
const TWO_INV = {
  ...MATCH,
  payment: { ...MATCH.payment, amount: 6294 },
  invoices: [
    { zohoId: "i1", number: "INV/26-27/0516", date: "2026-06-29", amountApplied: 3243, total: 3243,
      lines: [line("INV/26-27/0516", "Seat", 15, 180), line("INV/26-27/0516", "Storage", 1, 48)] },
    { zohoId: "i2", number: "INV/26-27/0517", date: "2026-06-29", amountApplied: 3051, total: 3051,
      lines: [line("INV/26-27/0517", "Seat", 14, 180), line("INV/26-27/0517", "Storage", 1, 66)] },
  ],
};
const twoTxn = { ...txn, txn_date: "2026-06-29", credit: 6294 } as unknown as BankTransactionRow;
const SPLIT_DONE = {
  kind: "split", amount: 6294, allocated: 6294, advance_credit: 0, round_off: 0, payment_id: "p1",
  parts: [
    { kind: "one_off", quote_id: "Q-1", invoice_id: "INV-A-1", invoice_issued: "INV-A-1", amount: 3243, new_quote: true, subscriptions: [], external_number: "INV/26-27/0516", external_number_saved: true },
    { kind: "one_off", quote_id: "Q-2", invoice_id: "INV-A-2", invoice_issued: "INV-A-2", amount: 3051, new_quote: true, subscriptions: [], external_number: "INV/26-27/0517", external_number_saved: true },
  ],
};

describe("R-2518 one app invoice per Zoho invoice", () => {
  it("two Zoho invoices → Save sends two sales (own lines + Zoho number) in one split call", async () => {
    answer = { ok: true, result: { kind: "match", match: TWO_INV } };
    render(<CreditPayForSection transaction={twoTxn} customers={customers} onDone={() => {}} />);
    findInZoho();
    await screen.findByLabelText("Zoho match");
    expect(screen.getByText(/Save books one app sale per Zoho invoice/)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "A new sale (no quote yet)" }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByLabelText("One app invoice per Zoho invoice").textContent).toContain("Zoho INV/26-27/0516: 2 lines, ₹3,243");
    state.split.mockResolvedValue(SPLIT_DONE);
    fireEvent.click(screen.getByRole("button", { name: "Record 2 sales (one per Zoho invoice) & reconcile ₹6,294" }));
    await waitFor(() => expect(state.split).toHaveBeenCalledTimes(1));
    expect(state.sale).not.toHaveBeenCalled();
    const arg = state.split.mock.calls[0][0];
    expect(arg.items).toEqual([]);
    expect(arg.rest).toBeNull();
    expect(arg.sale).toHaveLength(2);
    expect(arg.sale[0]).toMatchObject({ externalNumber: "INV/26-27/0516", amount: 3243 });
    expect(arg.sale[1]).toMatchObject({ externalNumber: "INV/26-27/0517", amount: 3051 });
    expect(arg.sale[0].lines.map((l: { qty: number; rate: number }) => [l.qty, l.rate])).toEqual([[15, 180], [1, 48]]);
    expect(arg.sale[1].lines.map((l: { qty: number; rate: number }) => [l.qty, l.rate])).toEqual([[14, 180], [1, 66]]);
    expect(await screen.findByText("Zoho invoice INV/26-27/0516 is kept on INV-A-1.")).toBeTruthy();
    expect(screen.getByText("Zoho invoice INV/26-27/0517 is kept on INV-A-2.")).toBeTruthy();
  });
});
