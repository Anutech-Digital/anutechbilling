// @vitest-environment jsdom
/* R-2216 — July staging reconcile: Banking → Reconcile → "A new sale" with a one-time line and two
   Workspace lines (Zoho invoices for different end-domains). The one-time line had no End-domain
   box, so typing the domains box-by-box in Zoho's line order put them on the wrong subscriptions.
   Every line now has its own End-domain box (optional on a one-time line); each domain stays on
   its own line through a save, a removed line and a commitment switch. */
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
    data: [
      { id: "E2E-ST", name: "E2E Google Workspace Business Starter", vendor: "google", msrp: 136, wholesale: 110, item_type: "subscription", is_active: true, prices: {} },
      { id: "E2E-SETUP", name: "E2E Setup fee", vendor: "anutech", msrp: 1000, wholesale: 0, item_type: "one_time", is_active: true, prices: {} },
    ],
  }),
}));
vi.mock("@/lib/compliance/gst-registration-query", () => ({ useGstRegistration: () => ({ data: { saved: null } }) }));

import { saleLinesPayload, type SaleLine } from "@/lib/banking/credit-pay-for";
import { CreditPayForSection } from "./credit-pay-for-section";

afterEach(cleanup);
beforeEach(() => { state.sale.mockReset(); });

const customers = [{ id: "c1", name: "E2E Test Co", country: "India", domain: "e2etest.example.in" }];
const txn = { id: "t1", bank_account_id: "b1", txn_date: "2026-07-10", description: "NEFT CR-E2E-UTR1", debit: 0, credit: 100000, reference: "UTR1" } as unknown as BankTransactionRow;

/** One-time setup first, then two Workspace lines — Zoho's line order; domains typed box by box. */
function saleOfThree() {
  render(<CreditPayForSection transaction={txn} customers={customers} onDone={() => {}} />);
  fireEvent.change(screen.getByLabelText("Customer who paid"), { target: { value: "c1" } });
  fireEvent.click(screen.getByRole("button", { name: "A new sale (no quote yet)" }));
  for (const id of ["E2E-SETUP", "E2E-ST", "E2E-ST"]) fireEvent.change(screen.getByLabelText("Add a product"), { target: { value: id } });
  const boxes = screen.getAllByLabelText("End domain");
  expect(boxes).toHaveLength(3);                          // a box on EVERY line, the one-time line too
  ["links.example.in", "a.example.in", "b.example.in"].forEach((d, i) => fireEvent.change(boxes[i], { target: { value: d } }));
}

const savedLines = (): SaleLine[] => state.sale.mock.calls[0][0].lines;
const record = () => fireEvent.click(screen.getByRole("button", { name: /^Record sale & reconcile/ }));

describe("R-2216 every sale line has its own End-domain box", () => {
  it("[one-time, annual, annual]: each Workspace line saves with its own domain", () => {
    saleOfThree();
    expect(screen.getByText(/One-time: no subscription is filed/)).toBeTruthy();
    record();
    const sent = saleLinesPayload(savedLines());
    expect(sent.map((l) => [l.item_id, l.commitment, "domain" in l ? l.domain : null])).toEqual([
      ["E2E-SETUP", "one_time", null],
      ["E2E-ST", "annual_yearly", "a.example.in"],
      ["E2E-ST", "annual_yearly", "b.example.in"],
    ]);
  });

  it("removing a line keeps the other boxes on their own lines", () => {
    saleOfThree();
    fireEvent.click(screen.getAllByRole("button", { name: "Remove E2E Google Workspace Business Starter" })[0]);
    expect(screen.getAllByLabelText("End domain").map((b) => (b as HTMLInputElement).value)).toEqual(["links.example.in", "b.example.in"]);
    record();
    expect(saleLinesPayload(savedLines())[1]).toMatchObject({ commitment: "annual_yearly", domain: "b.example.in" });
  });

  it("removing the one-time line does not shift the Workspace domains", () => {
    saleOfThree();
    fireEvent.click(screen.getByRole("button", { name: "Remove E2E Setup fee" }));
    record();
    expect(saleLinesPayload(savedLines()).map((l) => ("domain" in l ? l.domain : null))).toEqual(["a.example.in", "b.example.in"]);
  });
});
