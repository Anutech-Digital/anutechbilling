// @vitest-environment jsdom
/* R-2026 — Pardeep 27 Oct (staging, JAK GROUP, Business Starter): Reconcile → Customer → "A new
   sale" asks Commitment first, the price comes from the catalogue for that commitment (R-2050:
   ₹/user/year on Annual, ₹/user/month on Monthly flex), then Payment (Annual: Yearly / Half-yearly / Quarterly / Monthly; Monthly flex: Monthly
   only). Due now = the first bill, matched against the bank amount; the rest of the schedule shown.
   The customer list shows each name once. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { BankTransactionRow } from "@/lib/queries/bank";
import { formatDate } from "@/lib/utils";

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
    data: [{
      id: "GW-ST", name: "Google Workspace Business Starter", vendor: "google", msrp: 270, wholesale: 110,
      item_type: "subscription", is_active: true,
      prices: { annual: { msrp: 270, wholesale: 110 }, monthly: { msrp: 325, wholesale: 132 } },
    }],
  }),
}));
vi.mock("@/lib/compliance/gst-registration-query", () => ({ useGstRegistration: () => ({ data: { saved: null } }) }));

import { CreditPayForSection } from "./credit-pay-for-section";

afterEach(cleanup);
beforeEach(() => { state.sale.mockReset(); });

const customers = [
  { id: "jak", name: "JAK GROUP PRIVATE LIMITEDJAK GROUP PRIVATE LIMITED", country: "India" },
  { id: "c2", name: "Bharat Steel", country: "India" },
];
const txn = (credit: number) => ({
  id: "t1", bank_account_id: "b1", txn_date: "2026-10-21", description: "NEFT CR-SOMEONE-UTR1", debit: 0, credit, reference: "UTR1",
} as unknown as BankTransactionRow);

function newSale(credit: number) {
  render(<CreditPayForSection transaction={txn(credit)} customers={customers} onDone={() => {}} />);
  fireEvent.change(screen.getByLabelText("Customer who paid"), { target: { value: "jak" } });
  fireEvent.click(screen.getByRole("button", { name: "A new sale (no quote yet)" }));
  fireEvent.change(screen.getByLabelText("Add a product"), { target: { value: "GW-ST" } });
  fireEvent.change(screen.getByLabelText("Seats"), { target: { value: "10" } });
}
const optionValues = (label: string) =>
  Array.from((screen.getByLabelText(label) as HTMLSelectElement).options).map((o) => o.value);

describe("R-2026 new sale: Commitment first, then Payment", () => {
  it("Commitment comes before the price; Annual takes the catalogue's annual price, shown ₹/user/year (R-2050)", () => {
    newSale(9558);
    const commitment = screen.getByLabelText("Commitment") as HTMLSelectElement;
    const price = screen.getByLabelText("Unit price ₹/user/year") as HTMLInputElement;
    expect(commitment.compareDocumentPosition(price) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(optionValues("Commitment")).toEqual(["annual_yearly", "monthly", "one_time"]);
    expect(commitment.value).toBe("annual_yearly");
    expect(price.value).toBe("3240");
    expect(screen.queryByLabelText("Billing term")).toBeNull();   // the old Yearly/Monthly/One-time select is gone
  });

  it("Monthly flex: the monthly price, Payment offers Monthly only with a line why", () => {
    newSale(3835);
    fireEvent.change(screen.getByLabelText("Commitment"), { target: { value: "monthly" } });
    expect((screen.getByLabelText("Unit price ₹/user/month") as HTMLInputElement).value).toBe("325");
    expect(optionValues("Payment frequency")).toEqual(["monthly"]);
    expect((screen.getByLabelText("Payment frequency") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText(/Monthly flex has no commitment, so it is paid monthly only/)).toBeTruthy();
    expect(screen.getByText(/₹3,835 received = ₹3,835 due/)).toBeTruthy();
  });

  it("Annual + Quarterly: due now = a quarter + GST, matched to the bank amount, the next 3 bills shown; saved quarterly", async () => {
    state.sale.mockResolvedValue({
      kind: "new", quote_id: "Q-9", invoice_id: null, invoice_issued: "INV-77", payment_id: "p", receipt_voucher_no: null,
      amount: 9558, tds_amount: 0, outstanding: 28674, is_fully_paid: false, overpaid_credit: 0, renewal_rolled_forward: false,
      subscription_skipped: false, already_recorded: false, new_quote: true,
      subscriptions: [{ id: "s", plan: "Google Workspace Business Starter", seats: 10, start_date: "2026-10-21", renewal_date: "2027-10-21", billing_cycle: "quarterly" }],
    });
    newSale(9558);
    expect(optionValues("Payment frequency")).toEqual(["yearly", "half_yearly", "quarterly", "monthly"]);
    fireEvent.change(screen.getByLabelText("Payment frequency"), { target: { value: "quarterly" } });
    expect(screen.getByText(/Total ₹38,232/).closest("p")?.textContent).toContain("Due now ₹9,558 (first bill)");
    expect(screen.getByText(/₹9,558 received = ₹9,558 due/)).toBeTruthy();
    /* R-2052: with Create subscription ticked the next 3 bills are said once, in the paid-up line. */
    expect(screen.getByText(`Paid up to 20-01-2027 · next bill ₹9,558 on ${formatDate("2027-01-21")}, then 2 more ₹9,558 each, on ${formatDate("2027-04-21")} and ${formatDate("2027-07-21")}.`)).toBeTruthy();
    expect(screen.queryByText(/^Next 3 bills/)).toBeNull();
    /* Renewal follows the commitment: a year, not a quarter. */
    expect((screen.getByLabelText("Subscription renewal date") as HTMLInputElement).value).toBe("2027-10-21");
    fireEvent.click(screen.getByRole("button", { name: "Record sale & reconcile ₹9,558" }));
    const args = state.sale.mock.calls[0][0];
    expect(args).toMatchObject({ customerId: "jak", billingCycle: "quarterly", createSubscription: true, tdsAmount: 0 });
    expect(args.lines[0]).toMatchObject({ cycle: "annual_yearly", rate: 3240, cost: 1320, qty: 10 });
    expect(await screen.findByText("Subscription created: Google Workspace Business Starter × 10 · billed quarterly, renews 21 Oct 2027")).toBeTruthy();
  });

  it("Monthly flex is saved monthly even if Quarterly was picked before switching", () => {
    newSale(3835);
    fireEvent.change(screen.getByLabelText("Payment frequency"), { target: { value: "quarterly" } });
    fireEvent.change(screen.getByLabelText("Commitment"), { target: { value: "monthly" } });
    expect((screen.getByLabelText("Subscription renewal date") as HTMLInputElement).value).toBe("2026-11-21");
    fireEvent.click(screen.getByRole("button", { name: "Record sale & reconcile ₹3,835" }));
    expect(state.sale.mock.calls[0][0]).toMatchObject({ billingCycle: "monthly" });
    expect(state.sale.mock.calls[0][0].lines[0]).toMatchObject({ cycle: "monthly", rate: 325, cost: 132 });
  });
});

describe("R-2026 (5) customer dropdown", () => {
  it("shows the name once (not 'JAK GROUP PRIVATE LIMITEDJAK GROUP PRIVATE LIMITED')", () => {
    render(<CreditPayForSection transaction={txn(4814)} customers={customers} onDone={() => {}} />);
    const opts = Array.from((screen.getByLabelText("Customer who paid") as HTMLSelectElement).options).map((o) => o.textContent);
    expect(opts).toContain("JAK GROUP PRIVATE LIMITED");
    expect(opts.filter((t) => t?.includes("JAK GROUP"))).toEqual(["JAK GROUP PRIVATE LIMITED"]);
  });
});
