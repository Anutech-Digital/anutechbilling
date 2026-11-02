// @vitest-environment jsdom
/* R-2359 — Reconcile → a money-in line → "Find in Zoho". Owner's example (FY 2026-27 audit): HDFC
   21 Jul 2026 ₹27,081 from SUPREME MEDIA, UTR IDFB6202M2890149 = Zoho payment ref → INV/26-27/0613,
   9 × Business Starter @ ₹2,550/yr, gptalents.in, 21 Jul 2026 – 20 Jul 2027. The press fills the
   existing "A new sale" form; nothing is booked until Save. The server route is faked (no Zoho). */
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

describe("R-2359 Find in Zoho → pre-filled new sale", () => {
  it("fills customer, A new sale, product, 9 seats @ ₹2,550/yr and the Zoho dates — and books nothing", async () => {
    render(<CreditPayForSection transaction={txn} customers={customers} onDone={() => {}} />);
    findInZoho();
    await screen.findByLabelText("Zoho match");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/integrations/zoho-books/payment-match");
    expect(JSON.parse(String(init?.body))).toEqual({ transactionId: txn.id });   // no amount/UTR from the browser

    expect(screen.getByText("INV/26-27/0613")).toBeTruthy();
    expect(screen.getByText(/→ Supreme Media and Studios Pvt Ltd \(matched by name\)/)).toBeTruthy();
    expect((screen.getByLabelText("Customer who paid") as HTMLSelectElement).value).toBe("supreme");
    await waitFor(() => expect(screen.getByRole("button", { name: "A new sale (no quote yet)" }).getAttribute("aria-pressed")).toBe("true"));
    expect((screen.getByLabelText("Seats") as HTMLInputElement).value).toBe("9");
    expect((screen.getByLabelText("Unit price ₹/user/year") as HTMLInputElement).value).toBe("2550");
    await waitFor(() => expect((screen.getByLabelText("Subscription start date") as HTMLInputElement).value).toBe("2026-07-21"));
    expect((screen.getByLabelText("Subscription renewal date") as HTMLInputElement).value).toBe("2027-07-21");
    expect(screen.getByText(/₹27,081 received = ₹27,081 due/)).toBeTruthy();

    /* No save without the owner's click. */
    expect(state.sale).not.toHaveBeenCalled();
    expect(state.item).not.toHaveBeenCalled();
    expect(state.advance).not.toHaveBeenCalled();
    expect(state.split).not.toHaveBeenCalled();

    state.sale.mockResolvedValue({ kind: "new", quote_id: "Q-1", invoice_id: "INV-1", invoice_issued: "INV-1", payment_id: "p", receipt_voucher_no: null, amount: 27081, tds_amount: 0, outstanding: 0, is_fully_paid: true, overpaid_credit: 0, renewal_rolled_forward: false, subscription_skipped: false, already_recorded: false, new_quote: true, subscriptions: [] });
    fireEvent.click(screen.getByRole("button", { name: "Record sale & reconcile ₹27,081" }));
    await waitFor(() => expect(state.sale).toHaveBeenCalledTimes(1));
    const args = state.sale.mock.calls[0][0];
    expect(args).toMatchObject({ customerId: "supreme", createSubscription: true, subStart: "2026-07-21", subRenewal: "2027-07-21" });
    expect(args.lines[0]).toMatchObject({ itemId: "GW-ST", qty: 9, rate: 2550, cycle: "annual_yearly", domain: "gptalents.in" });
  });

  it("Zoho's customer not in the app → 'No match' + Create customer opens the Add-customer form", async () => {
    const onNewCustomer = vi.fn();
    render(<CreditPayForSection transaction={txn} customers={[customers[1]]} onDone={() => {}} onNewCustomer={onNewCustomer} />);
    findInZoho();
    expect(await screen.findByText(/No match — this customer is not in ResellerOS yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create customer" }));
    expect(onNewCustomer).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("Customer who paid") as HTMLSelectElement).value).toBe("");
  });

  it("Zoho not connected → what, why and a Connect Zoho Books link (§24)", async () => {
    answer = { ok: false, code: "not_connected", error: "Zoho Books is not connected.", why: "Find in Zoho reads your Zoho Books payments.", next: { label: "Connect Zoho Books", href: "/settings?tab=integrations" } };
    render(<CreditPayForSection transaction={txn} customers={customers} onDone={() => {}} />);
    findInZoho();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Zoho Books is not connected.");
    expect(alert.textContent).toContain("Find in Zoho reads your Zoho Books payments.");
    expect(screen.getByRole("link", { name: "Connect Zoho Books" }).getAttribute("href")).toBe("/settings?tab=integrations");
  });

  it("token expired → reconnect step; Zoho busy → Try again re-asks", async () => {
    answer = { ok: false, code: "busy", error: "Zoho is busy right now.", why: "Zoho limits how often it can be asked.", next: { label: "Try again" } };
    render(<CreditPayForSection transaction={txn} customers={customers} onDone={() => {}} />);
    findInZoho();
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("no match → says what was tried; several → the owner picks one, which is read by its id", async () => {
    answer = { ok: true, result: { kind: "none", utrs: ["IDFB6202M2890149"], from: "2026-07-18", to: "2026-07-24" } };
    render(<CreditPayForSection transaction={txn} customers={customers} onDone={() => {}} />);
    findInZoho();
    expect((await screen.findByText(/No Zoho payment found/)).closest("p")?.textContent).toContain("IDFB6202M2890149");
    cleanup();

    answer = { ok: true, result: { kind: "several", by: "amount_date", candidates: [
      { ...MATCH.payment, zohoId: "p1", number: "7801" }, { ...MATCH.payment, zohoId: "p2", number: "7802", customerName: "OTHER CO" },
    ] } };
    render(<CreditPayForSection transaction={txn} customers={customers} onDone={() => {}} />);
    findInZoho();
    const pick = await screen.findAllByRole("button", { name: "Use this payment" });
    answer = { ok: true, result: { kind: "match", match: { ...MATCH, by: "picked" } } };
    fireEvent.click(pick[0]);
    await screen.findByLabelText("Zoho match");
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))).toEqual({ transactionId: txn.id, paymentId: "p1" });
    expect(state.sale).not.toHaveBeenCalled();
  });
});
