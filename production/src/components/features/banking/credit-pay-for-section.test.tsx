// @vitest-environment jsdom
/* R-1838 — "This money is for:" on a money-in bank line. One test per path Pardeep named:
   renewal, add seats (pro-rata), fresh quote with "Create subscription" ticked / unticked,
   a new sale with seats × unit price, and a short receipt that is TDS. Each pins what reaches
   the server (one RPC per save) — the money work itself is proven by the SQL test. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { OpenItem, PayForResult } from "@/lib/banking/credit-pay-for";
import type { BankTransactionRow } from "@/lib/queries/bank";

const state = vi.hoisted(() => ({
  items: [] as unknown[],
  pay: vi.fn(),
  sale: vi.fn(),
  adv: vi.fn(),
  relink: vi.fn(),
}));

vi.mock("@/lib/queries/bank", () => ({
  useOpenInvoicesForCreditMatch: () => ({ data: [] }),
}));
vi.mock("@/lib/queries/bank-credit-pay-for", () => ({
  useBankCreditOpenItems: (id: string | null) => ({ data: id ? state.items : undefined, isLoading: false }),
  usePayItemFromBankCredit: () => ({ mutateAsync: state.pay, isPending: false }),
  useNewSaleFromBankCredit: () => ({ mutateAsync: state.sale, isPending: false }),
  useAdvanceFromBankCredit: () => ({ mutateAsync: state.adv, isPending: false }),
  useRelinkOneOffSale: () => ({ mutateAsync: state.relink, isPending: false }),
}));
vi.mock("@/lib/queries/items", () => ({
  useItems: () => ({
    data: [{
      id: "GW-PLUS", name: "Google Workspace Business Plus", vendor: "google", msrp: 1800, wholesale: 1500,
      item_type: "subscription", is_active: true, prices: { annual: { msrp: 1800, wholesale: 1500 } },
    }],
  }),
}));
vi.mock("@/lib/compliance/gst-registration-query", () => ({ useGstRegistration: () => ({ data: { saved: null } }) }));

import { CreditPayForSection } from "./credit-pay-for-section";

afterEach(cleanup);
beforeEach(() => { state.pay.mockReset(); state.sale.mockReset(); state.adv.mockReset(); state.relink.mockReset(); state.items = []; });

const customers = [{ id: "c1", name: "Acme Traders", country: "India" }, { id: "c2", name: "Bharat Steel", country: "India" }];
const txn = (credit: number): BankTransactionRow => ({
  id: "t1", bank_account_id: "b1", txn_date: "2026-10-20", description: "NEFT CR-ACME TRADERS-UTR1",
  debit: 0, credit, reference: "UTR1",
} as unknown as BankTransactionRow);

const item = (o: Partial<OpenItem>): OpenItem => ({
  kind: "new", quote_id: "Q-1", invoice_id: null, doc_date: "2026-10-10", amount_due: 11800,
  taxable_value: 10000, makes_subscription: false, subscription_id: null, plan: null, seats: null,
  renewal_date: null, lines: [], ...o,
});
const done = (o: Partial<PayForResult>): PayForResult => ({
  kind: "new", quote_id: "Q-1", invoice_id: null, invoice_issued: null, payment_id: "p1", receipt_voucher_no: null,
  amount: 0, tds_amount: 0, outstanding: 0, is_fully_paid: true, overpaid_credit: 0,
  renewal_rolled_forward: false, subscription_skipped: false, already_recorded: false, subscriptions: [], ...o,
});

const renderIt = (credit: number) =>
  render(<CreditPayForSection transaction={txn(credit)} customers={customers} onNewCustomer={() => {}} onProjectPayment={() => {}} onDone={() => {}} />);

describe("R-1838 CreditPayForSection", () => {
  it("renewal: customer guessed from the narration, the exact renewal quote pre-selected, result names the new renewal date", async () => {
    state.items = [
      item({ kind: "renewal", quote_id: "Q-REN", amount_due: 35400, taxable_value: 30000, plan: "Google Workspace", seats: 15, renewal_date: "2026-11-01" }),
      item({ kind: "add_seats", quote_id: "Q-ADD", amount_due: 4720, taxable_value: 4000 }),
    ];
    state.pay.mockResolvedValue(done({
      kind: "renewal", quote_id: "Q-REN", renewal_rolled_forward: true, invoice_issued: "INV-7", amount: 35400,
      subscriptions: [{ id: "s1", plan: "Google Workspace", seats: 15, start_date: "2025-11-01", renewal_date: "2027-11-01", billing_cycle: "yearly" }],
    }));
    renderIt(35400);
    expect((screen.getByLabelText("Customer who paid") as HTMLSelectElement).value).toBe("c1");
    expect(screen.getByText(/Guessed from the bank line says “acme”/)).toBeTruthy();
    expect(screen.getByRole("radio", { checked: true }).textContent).toContain("Renewal");
    expect(screen.queryByText("Create subscription")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Record ₹35,400 on Q-REN & reconcile" }));
    await screen.findByText("Done — this bank line is reconciled");
    expect(state.pay).toHaveBeenCalledTimes(1);
    expect(state.pay.mock.calls[0][0]).toMatchObject({ transactionId: "t1", quoteId: "Q-REN", invoiceId: null, tdsAmount: 0, createSubscription: null });
    expect(screen.getByText("Renewal of Google Workspace (15 seats) paid → subscription renewed to 1 Nov 2027")).toBeTruthy();
    expect(screen.getByText("Invoice INV-7 issued")).toBeTruthy();
  });

  it("add seats: the pro-rata quote is pre-selected on its exact amount", () => {
    state.items = [
      item({ kind: "renewal", quote_id: "Q-REN", amount_due: 35400 }),
      item({ kind: "add_seats", quote_id: "Q-ADD", amount_due: 4720, taxable_value: 4000 }),
    ];
    state.pay.mockResolvedValue(done({ kind: "add_seats" }));
    renderIt(4720);
    expect(screen.getByRole("radio", { checked: true }).textContent).toContain("Add seats · pro-rata");
    fireEvent.click(screen.getByRole("button", { name: "Record ₹4,720 on Q-ADD & reconcile" }));
    expect(state.pay.mock.calls[0][0]).toMatchObject({ quoteId: "Q-ADD", createSubscription: null });
  });

  it("fresh quote, subscription TICKED by default: start = bank date, renewal follows the term", () => {
    state.items = [item({ quote_id: "Q-NEW", makes_subscription: true, lines: [{ name: "GWS Standard", qty: 5, commitment: "annual_yearly" }] })];
    state.pay.mockResolvedValue(done({}));
    renderIt(11800);
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect((screen.getByLabelText("Subscription start date") as HTMLInputElement).value).toBe("2026-10-20");
    expect((screen.getByLabelText("Subscription renewal date") as HTMLInputElement).value).toBe("2027-10-20");
    fireEvent.change(screen.getByLabelText("Subscription renewal date"), { target: { value: "2027-10-31" } });
    fireEvent.click(screen.getByRole("button", { name: "Record ₹11,800 on Q-NEW & reconcile" }));
    expect(state.pay.mock.calls[0][0]).toMatchObject({ quoteId: "Q-NEW", createSubscription: true, subStart: "2026-10-20", subRenewal: "2027-10-31" });
  });

  it("fresh quote, subscription UNTICKED: says none will be made, sends false, no dates", async () => {
    state.items = [item({ quote_id: "Q-NEW", makes_subscription: true })];
    state.pay.mockResolvedValue(done({ quote_id: "Q-NEW", subscription_skipped: true }));
    renderIt(11800);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByText(/No subscription will be created/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Record ₹11,800 on Q-NEW & reconcile" }));
    expect(state.pay.mock.calls[0][0]).toMatchObject({ createSubscription: false, subStart: null, subRenewal: null });
    const warn = await screen.findByText(/No subscription created for this paid quote/);
    expect(warn.closest("a")?.getAttribute("href")).toBe("/quotes/Q-NEW");
  });

  it("new sale: asks seats and unit price, shows GST, and sends seats × price with Create subscription", () => {
    state.items = [];
    state.sale.mockResolvedValue(done({ new_quote: true }));
    renderIt(17700);
    expect(screen.getByRole("button", { name: "A new sale (no quote yet)" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByLabelText("Add a product"), { target: { value: "GW-PLUS" } });
    fireEvent.change(screen.getByLabelText("Seats"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Unit price"), { target: { value: "3000" } });
    expect(screen.getByText(/Taxable ₹15,000 · GST 18% ₹2,700/)).toBeTruthy();
    expect(screen.getByText(/₹17,700 received = ₹17,700 due/)).toBeTruthy();
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Record sale & reconcile ₹17,700" }));
    const args = state.sale.mock.calls[0][0];
    expect(args).toMatchObject({ customerId: "c1", createSubscription: true, subStart: "2026-10-20", tdsAmount: 0 });
    expect(args.lines[0]).toMatchObject({ itemId: "GW-PLUS", qty: 5, rate: 3000, cycle: "annual_yearly" });
  });

  it("short receipt that is 2% TDS: TDS pre-chosen, ₹200 TDS sent; Part payment sends none", () => {
    state.items = [item({ kind: "invoice", quote_id: "Q-INV", invoice_id: "INV-1", amount_due: 11800, taxable_value: 10000 })];
    state.pay.mockResolvedValue(done({}));
    renderIt(11600);
    expect(screen.getByText(/That is 2% TDS/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /TDS deducted/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Record ₹11,600 on INV-1 & reconcile" }));
    expect(state.pay.mock.calls[0][0]).toMatchObject({ invoiceId: "INV-1", tdsAmount: 200, tdsRatePct: 2 });

    fireEvent.click(screen.getByRole("button", { name: /Part payment/ }));
    fireEvent.click(screen.getByRole("button", { name: "Record ₹11,600 on INV-1 & reconcile" }));
    expect(state.pay.mock.calls[1][0]).toMatchObject({ tdsAmount: 0 });
  });
});

describe("R-1863 (c) Advance — nothing to invoice yet", () => {
  it("keeps the whole credit as the customer's advance: one advance call, no amount check, the card's message after save", async () => {
    state.items = [item({ kind: "renewal", quote_id: "Q-REN", amount_due: 35400 })];
    state.adv.mockResolvedValue(done({
      kind: "advance", quote_id: "Q-9", amount: 25000, advance_credit: 25000, customer_id: "c1", customer_name: "Acme Traders", receipt_voucher_no: "RV-1",
    }));
    renderIt(25000);
    fireEvent.click(screen.getByRole("button", { name: "Advance — nothing to invoice yet" }));
    expect(screen.getByRole("button", { name: "Advance — nothing to invoice yet" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/The whole ₹25,000 is kept as Acme Traders's advance credit/)).toBeTruthy();
    expect(screen.queryByText(/received is/)).toBeNull();
    expect(screen.queryByText("Create subscription")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keep ₹25,000 as advance & reconcile" }));
    const msg = await screen.findByText("₹25,000 kept as advance for Acme Traders — it will be offered when you record their next payment");
    expect(msg.closest("a")?.getAttribute("href")).toBe("/customers/c1");
    expect(state.adv).toHaveBeenCalledTimes(1);
    expect(state.adv.mock.calls[0][0]).toMatchObject({ path: "advance", transactionId: "t1", customerId: "c1" });
    expect(state.pay).not.toHaveBeenCalled();
    expect(state.sale).not.toHaveBeenCalled();
  });

  it("relink: the same choice goes through the ONE relink call, never the plain reconcile paths", async () => {
    state.items = [item({ kind: "renewal", quote_id: "Q-REN", amount_due: 11800 })];
    state.relink.mockResolvedValue(done({ kind: "renewal", quote_id: "Q-REN", relinked_from_quote: "Q-OLD", old_invoice_credited: "INV-4", old_credit_note_id: "CN-1" }));
    render(<CreditPayForSection transaction={txn(11800)} customers={customers} pickedCustomerId="c1" onDone={() => {}}
      relink={{ txn_id: "t1", txn_date: "2026-10-12", amount: 11800, description: null, payment_id: "p", receipt_voucher_no: null, received_on: "2026-10-12",
                quote_id: "Q-OLD", customer_id: "c1", customer_name: "Acme Traders", product: null, invoice_id: "INV-4", invoice_status: "paid",
                invoice_date: "2026-10-12", invoice_amount: 11800, blocker: null }} />);
    expect(screen.queryByRole("button", { name: "Project payment" })).toBeNull();
    expect(screen.queryByText("＋ New customer")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Relink: Record ₹11,800 on Q-REN & reconcile" }));
    await screen.findByText("Old one-off sale Q-OLD undone — invoice INV-4 reversed by credit note CN-1");
    expect(state.relink.mock.calls[0][0]).toMatchObject({ path: "item", transactionId: "t1", quoteId: "Q-REN" });
    expect(state.pay).not.toHaveBeenCalled();
  });
});
