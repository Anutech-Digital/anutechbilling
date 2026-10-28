// @vitest-environment jsdom
/* R-2025 (2)(4) — money in from someone else's account (Pardeep's staging line, ₹16,709):
     NEFT CR-INDB0000006-SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED-ORBIT SOFTWARE-INDBH23101090759
   Picking a customer whose name is not the payer → an amber warning + three answers; Save needs
   one; the answer is sent (set_bank_line_payer) BEFORE the save so the save's own transaction
   writes it on the receipt and learns it. A known payer → no warning, the customer guessed. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { BankTransactionRow } from "@/lib/queries/bank";
import type { KnownPayer } from "@/lib/banking/customer-payer";

const state = vi.hoisted(() => ({
  calls: [] as string[], adv: vi.fn(), setPayer: vi.fn(), payers: [] as unknown[],
}));

vi.mock("@/lib/queries/bank", () => ({ useOpenInvoicesForCreditMatch: () => ({ data: [] }) }));
vi.mock("@/lib/queries/bank-credit-pay-for", () => ({
  useBankCreditOpenItems: (id: string | null) => ({ data: id ? [] : undefined, isLoading: false }),
  usePayItemFromBankCredit: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useNewSaleFromBankCredit: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAdvanceFromBankCredit: () => ({ mutateAsync: state.adv, isPending: false }),
  useRelinkOneOffSale: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/queries/customer-payers", () => ({
  usePayerMemory: () => ({ payers: state.payers, ownNames: ["Orbit Software"] }),
  useSetBankLinePayer: () => ({ mutateAsync: state.setPayer, isPending: false }),
}));
vi.mock("@/lib/queries/items", () => ({ useItems: () => ({ data: [] }) }));
vi.mock("@/lib/compliance/gst-registration-query", () => ({ useGstRegistration: () => ({ data: { saved: null } }) }));

import { CreditPayForSection } from "./credit-pay-for-section";

afterEach(cleanup);
beforeEach(() => {
  state.calls = []; state.payers = [];
  state.adv.mockReset().mockImplementation(async () => {
    state.calls.push("save");
    return {
      kind: "advance", quote_id: "Q-9", invoice_id: null, invoice_issued: null, payment_id: "p1", receipt_voucher_no: "RV-1",
      amount: 16709, tds_amount: 0, outstanding: 0, is_fully_paid: true, overpaid_credit: 0, advance_credit: 16709,
      customer_id: "c-links", customer_name: "Links Infotech", renewal_rolled_forward: false, subscription_skipped: false,
      already_recorded: false, subscriptions: [],
    };
  });
  state.setPayer.mockReset().mockImplementation(async () => { state.calls.push("payer"); });
});

const SHREE = "NEFT CR-INDB0000006-SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED-ORBIT SOFTWARE-INDBH23101090759";
const txn = { id: "t1", bank_account_id: "b1", txn_date: "2026-10-23", description: SHREE, debit: 0, credit: 16709, reference: "INDBH23101090759" } as unknown as BankTransactionRow;
const customers = [
  { id: "c-links", name: "Links Infotech", country: "India" },
  { id: "c-shree", name: "Shree Nandik Technologies Pvt Ltd", country: "India" },
];
const known: KnownPayer = {
  id: "kp1", customer_id: "c-links", payer_name: "SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED",
  payer_name_key: "shree nandik technologies private limited", relation: "director", note: null,
  ifsc: "INDB0000006", upi_id: null, account_tail: null, uses: 1, first_seen_txn: "t0", created_at: "2026-10-27T12:00:00Z",
};
const WARN = "This money came from SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED, not from Links Infotech.";
const OWN_ACCOUNT = "Customer’s own other account";
const BEHALF = "Paid on the customer’s behalf";
const WRONG = "Wrong customer — change";
const renderIt = () => render(<CreditPayForSection transaction={txn} customers={customers} onDone={() => {}} />);
const pick = (id: string) => fireEvent.change(screen.getByLabelText("Customer who paid"), { target: { value: id } });
const advance = () => fireEvent.click(screen.getByRole("button", { name: "Advance — nothing to invoice yet" }));
const saveBtn = () => screen.getByRole("button", { name: "Keep ₹16,709 as advance & reconcile" }) as HTMLButtonElement;

describe("R-2025 payer differs from the customer", () => {
  it("warns with three answers; Save locked until one is chosen; the answer goes BEFORE the save", async () => {
    renderIt();
    pick("c-links");
    expect(screen.getByText(WARN)).toBeTruthy();
    for (const n of [OWN_ACCOUNT, BEHALF, WRONG]) expect(screen.getByRole("button", { name: n })).toBeTruthy();
    advance();
    expect(saveBtn().disabled).toBe(true);
    expect(screen.getByText("Say who paid (above) before saving.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: BEHALF }));
    fireEvent.click(screen.getByRole("button", { name: "Director / partner / owner" }));
    fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value: "MD's other company" } });
    expect(saveBtn().disabled).toBe(false);
    fireEvent.click(saveBtn());
    await screen.findByText("Done — this bank line is reconciled");
    expect(state.calls).toEqual(["payer", "save"]);
    expect(state.setPayer.mock.calls[0][0]).toMatchObject({
      transactionId: "t1", customerId: "c-links", relation: "director", note: "MD's other company",
      payer: { name: "SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED", ifsc: "INDB0000006" },
    });
    expect(state.adv.mock.calls[0][0]).toMatchObject({ customerId: "c-links" });   // the receipt stays Links'
  });

  it("'Paid on the customer's behalf' alone is enough (one click) — third party by default", async () => {
    renderIt();
    pick("c-links");
    advance();
    fireEvent.click(screen.getByRole("button", { name: BEHALF }));
    fireEvent.click(saveBtn());
    await screen.findByText("Done — this bank line is reconciled");
    expect(state.setPayer.mock.calls[0][0]).toMatchObject({ relation: "third_party", note: null });
  });

  it("'Customer's own other account' → own_account", async () => {
    renderIt();
    pick("c-links");
    advance();
    fireEvent.click(screen.getByRole("button", { name: OWN_ACCOUNT }));
    fireEvent.click(saveBtn());
    await waitFor(() => expect(state.adv).toHaveBeenCalled());
    expect(state.setPayer.mock.calls[0][0]).toMatchObject({ relation: "own_account" });
  });

  it("'Wrong customer — change' clears the customer; nothing is saved", () => {
    renderIt();
    pick("c-links");
    fireEvent.click(screen.getByRole("button", { name: WRONG }));
    expect((screen.getByLabelText("Customer who paid") as HTMLSelectElement).value).toBe("");
    expect(screen.queryByText(WARN)).toBeNull();
    expect(state.setPayer).not.toHaveBeenCalled();
    expect(state.adv).not.toHaveBeenCalled();
  });

  it("if the answer cannot be saved, the line is not booked", async () => {
    state.setPayer.mockReset().mockRejectedValue(new Error("network"));
    renderIt();
    pick("c-links");
    advance();
    fireEvent.click(screen.getByRole("button", { name: BEHALF }));
    fireEvent.click(saveBtn());
    await waitFor(() => expect(state.setPayer).toHaveBeenCalled());
    expect(state.adv).not.toHaveBeenCalled();
  });

  it("the customer IS the payer (Pvt / Private either way) → no warning, no payer sent", async () => {
    renderIt();
    pick("c-shree");
    expect(screen.queryByText(/This money came from/)).toBeNull();
    advance();
    fireEvent.click(saveBtn());
    await waitFor(() => expect(state.adv).toHaveBeenCalled());
    expect(state.setPayer).not.toHaveBeenCalled();
  });

  it("a KNOWN payer of Links: Links guessed ('known payer for Links Infotech'), no warning, the known relation is recorded", async () => {
    state.payers = [known];
    renderIt();
    expect((screen.getByLabelText("Customer who paid") as HTMLSelectElement).value).toBe("c-links");
    expect(screen.getByText("Guessed from known payer for Links Infotech — change it if wrong.")).toBeTruthy();
    expect(screen.queryByText(/This money came from/)).toBeNull();
    advance();
    fireEvent.click(saveBtn());
    await waitFor(() => expect(state.adv).toHaveBeenCalled());
    expect(state.setPayer.mock.calls[0][0]).toMatchObject({ relation: "director", customerId: "c-links" });
  });

  it("the same payer known for TWO customers → no guess; the owner picks", () => {
    state.payers = [known, { ...known, id: "kp2", customer_id: "c-shree" }];
    renderIt();
    expect((screen.getByLabelText("Customer who paid") as HTMLSelectElement).value).toBe("");
  });
});
