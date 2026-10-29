// @vitest-environment jsdom
/* R-2025 (0) — Pardeep 27 Oct 11:44Z (localhost, R-2023 check): in Reconcile money-in, picking a
   customer pre-selected "A new sale (no quote yet)" — one Save would book a sale + GST invoice +
   subscription on money that was really an advance. Now NOTHING is pre-chosen, each of the three
   says what it does, and Save stays locked (with the reason) until one is picked. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { OpenItem } from "@/lib/banking/credit-pay-for";
import type { BankTransactionRow } from "@/lib/queries/bank";

const state = vi.hoisted(() => ({ items: [] as unknown[], pay: vi.fn(), sale: vi.fn(), adv: vi.fn(), relink: vi.fn() }));

/* R-2025: no known payers, our own name (the payer warning / known-payer guess). */
vi.mock("@/lib/queries/customer-payers", () => ({
  usePayerMemory: () => ({ payers: [], ownNames: [] }),
  useSetBankLinePayer: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/queries/bank", () => ({ useOpenInvoicesForCreditMatch: () => ({ data: [] }) }));
vi.mock("@/lib/queries/bank-credit-pay-for", () => ({
  useBankCreditOpenItems: (id: string | null) => ({ data: id ? state.items : undefined, isLoading: false }),
  usePayItemFromBankCredit: () => ({ mutateAsync: state.pay, isPending: false }),
  useNewSaleFromBankCredit: () => ({ mutateAsync: state.sale, isPending: false }),
  useAdvanceFromBankCredit: () => ({ mutateAsync: state.adv, isPending: false }),
  useRelinkOneOffSale: () => ({ mutateAsync: state.relink, isPending: false }),
  useSplitFromBankCredit: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/queries/items", () => ({ useItems: () => ({ data: [] }) }));
vi.mock("@/lib/compliance/gst-registration-query", () => ({ useGstRegistration: () => ({ data: { saved: null } }) }));

import { CreditPayForSection } from "./credit-pay-for-section";

afterEach(cleanup);
beforeEach(() => { state.items = []; state.pay.mockReset(); state.sale.mockReset(); state.adv.mockReset(); });

const customers = [{ id: "c1", name: "Acme Traders", country: "India" }, { id: "c2", name: "Bharat Steel", country: "India" }];
const txn = { id: "t1", bank_account_id: "b1", txn_date: "2026-10-20", description: "NEFT CR-SOMEONE-UTR1", debit: 0, credit: 400000, reference: "UTR1" } as unknown as BankTransactionRow;
const item = (o: Partial<OpenItem>): OpenItem => ({
  kind: "new", quote_id: "Q-1", invoice_id: null, doc_date: "2026-10-10", amount_due: 400000, taxable_value: 338983,
  makes_subscription: false, subscription_id: null, plan: null, seats: null, renewal_date: null, lines: [], ...o,
});
const modes = ["An open quote / invoice", "A new sale (no quote yet)", "Advance — nothing to invoice yet"];

const pickCustomer = (id = "c2") => fireEvent.change(screen.getByLabelText("Customer who paid"), { target: { value: id } });

describe("R-2025 (0) no pre-selected 'what for' after choosing the customer", () => {
  it("customer with nothing open (the Acme ₹4,00,000 case): none of the three is pressed, Save locked with the reason", () => {
    render(<CreditPayForSection transaction={txn} customers={customers} onDone={() => {}} />);
    pickCustomer();
    for (const m of modes) expect(screen.getByRole("button", { name: m }).getAttribute("aria-pressed")).toBe("false");
    const save = screen.getByRole("button", { name: "Choose what this money is for" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByText("Choose what this money is for — nothing is booked until you do.")).toBeTruthy();
    expect(screen.queryByLabelText("Add a product")).toBeNull();
  });

  it("customer WITH an exact open quote: still nothing pre-chosen (the quote is ticked only after 'An open quote / invoice')", () => {
    state.items = [item({ quote_id: "Q-7" })];
    render(<CreditPayForSection transaction={txn} customers={customers} onDone={() => {}} />);
    pickCustomer();
    for (const m of modes) expect(screen.getByRole("button", { name: m }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("radio")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "An open quote / invoice" }));
    expect(screen.getByRole("radio", { checked: true }).textContent).toContain("Due ₹4,00,000");
    expect((screen.getByRole("button", { name: "Record ₹4,00,000 on Q-7 & reconcile" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("each choice carries one plain line saying what it will do", () => {
    render(<CreditPayForSection transaction={txn} customers={customers} onDone={() => {}} />);
    pickCustomer();
    expect(screen.getByRole("button", { name: "An open quote / invoice" }).getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("Pays the quote → service starts + GST invoice")).toBeTruthy();
    expect(screen.getByText("Records a sale → GST invoice + subscription")).toBeTruthy();
    expect(screen.getByText("Customer credit, no invoice — use it on the next bill")).toBeTruthy();
  });

  it("changing the customer clears the choice again", () => {
    render(<CreditPayForSection transaction={txn} customers={customers} onDone={() => {}} />);
    pickCustomer("c1");
    fireEvent.click(screen.getByRole("button", { name: "Advance — nothing to invoice yet" }));
    expect(screen.getByRole("button", { name: "Keep ₹4,00,000 as advance & reconcile" })).toBeTruthy();
    pickCustomer("c2");
    expect(screen.getByRole("button", { name: "Advance — nothing to invoice yet" }).getAttribute("aria-pressed")).toBe("false");
    expect((screen.getByRole("button", { name: "Choose what this money is for" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the Suggestion card's Change (R-2007) still arrives with its open item ticked", () => {
    state.items = [item({ quote_id: "Q-A" }), item({ quote_id: "Q-B", amount_due: 5000 })];
    render(<CreditPayForSection transaction={txn} customers={customers} pickedCustomerId="c1" suggested={{ itemKey: "q:Q-B", tds: false }} onDone={() => {}} />);
    expect(screen.getByRole("button", { name: "An open quote / invoice" }).getAttribute("aria-pressed")).toBe("true");
  });
});
