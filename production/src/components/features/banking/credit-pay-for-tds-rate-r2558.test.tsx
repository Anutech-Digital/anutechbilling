// @vitest-environment jsdom
/* R-2558 — Banking → credit line → Reconcile → "A new sale" with TDS (R-2538 card test, 7 Nov):
   50 seats × ₹3,150/user/year, Annual commitment billed Half-yearly → part 1 = ₹78,750 + 18% GST =
   ₹92,925 due now; the whole year's taxable is ₹1,57,500.
   · ₹89,775 in = ₹3,150 TDS = 2% of the WHOLE year → the form must send rate 2 (it sent 4 = TDS ÷ part),
     so the server's R-2538 rule books gross ₹1,57,500.
   · A gap that fits no rate: nothing pre-chosen (no "Part payment", no 194J) — the owner answers,
     types the rate, and the section follows the typed rate. */
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
    data: [{
      id: "M365-B", name: "Microsoft 365 Business Basic", vendor: "microsoft", msrp: 3150, wholesale: 200,
      item_type: "subscription", is_active: true, prices: { annual: { msrp: 3150, wholesale: 200 } },
    }],
  }),
}));
vi.mock("@/lib/compliance/gst-registration-query", () => ({ useGstRegistration: () => ({ data: { saved: null } }) }));

import { CreditPayForSection, type PayForCustomer } from "./credit-pay-for-section";

afterEach(cleanup);
beforeEach(() => { state.sale.mockReset(); state.sale.mockResolvedValue({ kind: "new", quote_id: "Q-1", payment_id: "p1", subscriptions: [] }); });

const plain: PayForCustomer = { id: "ct", name: "CT Full TDS Pvt Ltd", country: "India" };
const txn = (credit: number) => ({
  id: "t1", bank_account_id: "b1", txn_date: "2026-11-06", description: "NEFT CR-HDFC-CT FULL TDS PVT LTD", debit: 0, credit, reference: "UTR1",
} as unknown as BankTransactionRow);

function halfYearlySale(credit: number, customers: PayForCustomer[] = [plain]) {
  render(<CreditPayForSection transaction={txn(credit)} customers={customers} onDone={() => {}} />);
  fireEvent.change(screen.getByLabelText("Customer who paid"), { target: { value: customers[0].id } });
  fireEvent.click(screen.getByRole("button", { name: "A new sale (no quote yet)" }));
  fireEvent.change(screen.getByLabelText("Add a product"), { target: { value: "M365-B" } });
  fireEvent.change(screen.getByLabelText("Seats"), { target: { value: "50" } });
  fireEvent.change(screen.getByLabelText("Unit price ₹/user/year"), { target: { value: "3150" } });
  fireEvent.change(screen.getByLabelText("Payment frequency"), { target: { value: "half_yearly" } });
  expect(screen.getByText(/Due now ₹92,925/)).toBeTruthy();
}
const saveBtn = () => screen.getByRole("button", { name: /^Record sale & reconcile/ }) as HTMLButtonElement;

describe("R-2558 bank New sale — TDS rate box", () => {
  it("₹3,150 TDS on the half-yearly part (2% of the whole year): TDS pre-chosen, rate 2 (not 4), 194C, gross ₹1,57,500 shown and sent", () => {
    halfYearlySale(89775);
    expect(screen.getByRole("button", { name: "TDS deducted (₹3,150)" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText("TDS rate %") as HTMLInputElement).value).toBe("2");
    expect((screen.getByLabelText("TDS section") as HTMLSelectElement).value).toBe("194C");
    expect(screen.getByText(/2% of the whole sale's taxable ₹1,57,500/)).toBeTruthy();
    expect(screen.getByText(/gross ₹1,57,500 @ 2%/)).toBeTruthy();
    fireEvent.click(saveBtn());
    expect(state.sale).toHaveBeenCalledTimes(1);
    const args = state.sale.mock.calls[0][0];
    expect(args).toMatchObject({ tdsAmount: 3150, tdsRatePct: 2, tdsSection: "194C", billingCycle: "half_yearly" });
    expect(args.tdsRatePct).not.toBe(4);
  });

  it("₹1,575 TDS = 2% of the part: rate 2 on the part, gross ₹78,750", () => {
    halfYearlySale(91350);
    expect((screen.getByLabelText("TDS rate %") as HTMLInputElement).value).toBe("2");
    expect(screen.getByText(/gross ₹78,750 @ 2%/)).toBeTruthy();
    fireEvent.click(saveBtn());
    expect(state.sale.mock.calls[0][0]).toMatchObject({ tdsAmount: 1575, tdsRatePct: 2, tdsSection: "194C" });
  });

  it("a gap that fits no rate: nothing pre-chosen, Save waits; TDS → rate box empty, no section; typing 10 → 194J, rate 10 sent", () => {
    halfYearlySale(89925);   // ₹3,000 short — not 1/2/5/10% of the part or the year
    expect(screen.getByRole("button", { name: /TDS deducted/ }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: /Part payment/ }).getAttribute("aria-pressed")).toBe("false");
    expect(saveBtn().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /TDS deducted/ }));
    expect((screen.getByLabelText("TDS rate %") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("TDS section") as HTMLSelectElement).value).toBe("");
    expect(screen.getByText("Enter the TDS rate (%) the customer deducted at.")).toBeTruthy();
    expect(saveBtn().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("TDS rate %"), { target: { value: "10" } });
    expect((screen.getByLabelText("TDS section") as HTMLSelectElement).value).toBe("194J");
    expect(saveBtn().disabled).toBe(false);
    fireEvent.click(saveBtn());
    expect(state.sale.mock.calls[0][0]).toMatchObject({ tdsAmount: 3000, tdsRatePct: 10, tdsSection: "194J" });
  });

  it("the customer's saved TDS (194C @ 1%) wins when it fits — ₹1,575 is 1% of the whole year", () => {
    halfYearlySale(91350, [{ ...plain, tds_default_section: "194C", tds_default_rate_pct: 1 }]);
    expect((screen.getByLabelText("TDS rate %") as HTMLInputElement).value).toBe("1");
    expect(screen.getByText(/gross ₹1,57,500 @ 1%/)).toBeTruthy();
    fireEvent.click(saveBtn());
    expect(state.sale.mock.calls[0][0]).toMatchObject({ tdsAmount: 1575, tdsRatePct: 1, tdsSection: "194C" });
  });

  it("the owner can change the pre-filled rate; Part payment sends no TDS", () => {
    halfYearlySale(89775);
    fireEvent.change(screen.getByLabelText("TDS rate %"), { target: { value: "0" } });
    expect(screen.getByText("TDS rate is a % between 0 and 100.")).toBeTruthy();
    expect(saveBtn().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Part payment/ }));
    expect(saveBtn().disabled).toBe(false);
    fireEvent.click(saveBtn());
    expect(state.sale.mock.calls[0][0]).toMatchObject({ tdsAmount: 0 });
  });
});
