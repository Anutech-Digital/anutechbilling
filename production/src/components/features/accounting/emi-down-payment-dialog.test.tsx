// @vitest-environment jsdom
/* R-2395 — "Down payment: paid from". Owner example (staging 3 Nov): Thar Roxx, ₹2,00,000 down on
   3 Feb 2026, posted on an FD that opened 29 Aug 2026; the owner paid it in cash himself. The dialog
   shows where it sits now, starts with nothing picked, cannot pick an account opened later, and
   one save sends Paid by owner (or the account) to the server. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mutateAsync = vi.fn();
let source: unknown = { kind: "account", accountId: "fd-1", imported: false, amount: 200000, date: "2026-02-03" };
let businessType = "proprietor";
vi.mock("@/lib/queries/bank", () => ({
  useBankAccounts: () => ({ data: [
    { id: "hdfc-1", name: "HDFC Current", is_active: true, account_type: "current", opening_balance_date: "2026-01-01" },
    { id: "fd-1", name: "HDFC FD 2107", is_active: true, account_type: "fixed_deposit", opening_balance_date: "2026-08-29" },
    { id: "cash-1", name: "Petty Cash", is_active: true, account_type: "cash", opening_balance_date: "2026-01-01" },
    { id: "cc-1", name: "HDFC Card", is_active: true, account_type: "credit_card", opening_balance_date: "2026-01-01" },
  ] }),
}));
vi.mock("@/lib/compliance/profile", () => ({ useComplianceProfile: () => ({ data: { businessType } }) }));
vi.mock("@/lib/queries/emi", () => ({
  useEmiDownPayment: () => ({ data: source, isLoading: false, isError: false }),
  useChangeEmiDownPaymentSource: () => ({ mutateAsync, isPending: false }),
}));

import { EmiDownPaymentDialog } from "./emi-down-payment-dialog";
import type { EmiPurchase } from "@/lib/queries/emi";

const thar = {
  id: "p-thar", name: "Thar Roxx", down_payment: 200000, processing_fee: 0, processing_fee_gst: 0,
  purchased_on: "2026-02-03", down_bank_txn_id: "t-down", down_account_id: "fd-1",
} as unknown as EmiPurchase;
const save = () => screen.getByRole("button", { name: "Save paid from" }) as HTMLButtonElement;

afterEach(cleanup);
beforeEach(() => {
  mutateAsync.mockReset(); mutateAsync.mockResolvedValue({});
  source = { kind: "account", accountId: "fd-1", imported: false, amount: 200000, date: "2026-02-03" };
  businessType = "proprietor";
});

describe("R-2395 Down payment: paid from", () => {
  it("Thar: shows the FD now, nothing picked, the FD itself and the credit card not offered", () => {
    render(<EmiDownPaymentDialog purchase={thar} onClose={vi.fn()} />);
    expect(screen.getByTestId("down-now").textContent).toBe("HDFC FD 2107");
    expect(screen.getByText(/₹2,00,000 paid on/)).toBeTruthy();
    expect((screen.getByLabelText("Paid from") as HTMLSelectElement).value).toBe("");
    expect(save().disabled).toBe(true);
    expect(screen.queryByRole("option", { name: /HDFC FD 2107/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /HDFC Card/ })).toBeNull();
  });

  it("Thar: FD → Paid by owner, one save", async () => {
    const close = vi.fn();
    render(<EmiDownPaymentDialog purchase={thar} onClose={close} />);
    fireEvent.change(screen.getByLabelText("Paid from"), { target: { value: "__owner__" } });
    expect(screen.getByText(/capital goes up by ₹2,00,000/)).toBeTruthy();
    fireEvent.click(save());
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    expect(mutateAsync).toHaveBeenCalledWith({ purchaseId: "p-thar", accountId: null, paidByOwner: true, partner: null });
  });

  it("an account opened after the payment cannot be picked; Petty Cash can", async () => {
    source = { kind: "owner", amount: 200000, date: "2026-02-03", partner: null };
    render(<EmiDownPaymentDialog purchase={thar} onClose={vi.fn()} />);
    expect(screen.getByTestId("down-now").textContent).toContain("Paid by owner");
    expect((screen.getByRole("option", { name: /HDFC FD 2107 — opened/ }) as HTMLOptionElement).disabled).toBe(true);
    expect(screen.queryByRole("option", { name: /Paid by owner/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("Paid from"), { target: { value: "cash-1" } });
    fireEvent.click(save());
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ accountId: "cash-1", paidByOwner: false });
  });

  it("reconciled to a statement line: no change here, says why", () => {
    source = { kind: "account", accountId: "hdfc-1", imported: true, amount: 200000, date: "2026-02-03" };
    render(<EmiDownPaymentDialog purchase={thar} onClose={vi.fn()} />);
    expect(screen.getByText(/un-reconcile the line in Banking first/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save paid from" })).toBeNull();
  });

  it("Pvt Ltd: no Paid by owner option", () => {
    businessType = "pvt_ltd";
    render(<EmiDownPaymentDialog purchase={thar} onClose={vi.fn()} />);
    expect(screen.queryByRole("option", { name: /Paid by/ })).toBeNull();
  });

  it("partnership: Paid by partner needs the partner", () => {
    businessType = "partnership";
    render(<EmiDownPaymentDialog purchase={thar} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Paid from"), { target: { value: "__owner__" } });
    expect(save().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Which partner"), { target: { value: "Pardeep" } });
    expect(save().disabled).toBe(false);
  });
});
