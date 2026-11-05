// @vitest-environment jsdom
/* R-2515 — May staging reconcile (R-2094): an SEZ customer with a Haryana GSTIN paid ₹55,223 for a
   Zoho invoice at 0% GST. Banking → Reconcile → "A new sale" added 18% GST because only a customer
   abroad was zero-rated. A customer whose GST treatment is "SEZ (without payment)" now gets the sale
   at 0% (the server, bank_credit_new_sale_quote, applies the same rule); "SEZ (with payment)" stays 18%. */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { BankTransactionRow } from "@/lib/queries/bank";

vi.mock("@/lib/queries/customer-payers", () => ({
  usePayerMemory: () => ({ payers: [], ownNames: [] }),
  useSetBankLinePayer: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/queries/bank", () => ({ useOpenInvoicesForCreditMatch: () => ({ data: [] }) }));
vi.mock("@/lib/queries/bank-credit-pay-for", () => ({
  useBankCreditOpenItems: () => ({ data: [], isLoading: false }),
  usePayItemFromBankCredit: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useNewSaleFromBankCredit: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAdvanceFromBankCredit: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRelinkOneOffSale: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSplitFromBankCredit: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/queries/items", () => ({
  useItems: () => ({
    data: [{ id: "E2E-SETUP", name: "E2E Setup fee", vendor: "anutech", msrp: 55223, wholesale: 0, item_type: "one_time", is_active: true, prices: {} }],
  }),
}));
vi.mock("@/lib/compliance/gst-registration-query", () => ({ useGstRegistration: () => ({ data: { saved: null } }) }));

import { CreditPayForSection } from "./credit-pay-for-section";

afterEach(cleanup);

const customers = [
  { id: "sez0", name: "Gurugram SEZ Unit", country: "India", gstin: "06AAACS2515E1Z5", gst_treatment: "sez_without_payment" },
  { id: "sez18", name: "Delhi SEZ Paid", country: "India", gstin: "07AAACS2515P1Z5", gst_treatment: "sez_with_payment" },
];
const txn = { id: "t1", bank_account_id: "b1", txn_date: "2026-05-04", description: "NEFT CR-CITI-SEZ", debit: 0, credit: 55223, reference: "CITIN25150001" } as unknown as BankTransactionRow;

function newSaleFor(customerId: string) {
  render(<CreditPayForSection transaction={txn} customers={customers} onDone={() => {}} />);
  fireEvent.change(screen.getByLabelText("Customer who paid"), { target: { value: customerId } });
  fireEvent.click(screen.getByRole("button", { name: "A new sale (no quote yet)" }));
  fireEvent.change(screen.getByLabelText("Add a product"), { target: { value: "E2E-SETUP" } });
}

describe("R-2515 bank receipt → A new sale for an SEZ customer", () => {
  it("SEZ (without payment): No GST — the total is the money received", () => {
    newSaleFor("sez0");
    expect(screen.getByText(/No GST/)).toBeTruthy();
    expect(screen.queryByText(/GST 18%/)).toBeNull();
  });

  it("SEZ (with payment): GST 18% (IGST)", () => {
    newSaleFor("sez18");
    expect(screen.getByText(/GST 18%/)).toBeTruthy();
  });
});
