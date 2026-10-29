// @vitest-environment jsdom
/* R-1863 — Relink an old one-off bank sale: the dialog says what will happen before anything
   changes, and a booking it cannot undo says why and where to fix it (§24). */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { OldOneOffBooking } from "@/lib/banking/credit-pay-for";
import type { BankTransactionRow } from "@/lib/queries/bank";

/* R-2025: no known payers, our own name (the payer warning / known-payer guess). */
vi.mock("@/lib/queries/customer-payers", () => ({
  usePayerMemory: () => ({ payers: [], ownNames: [] }),
  useSetBankLinePayer: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/queries/customers", () => ({ useCustomers: () => ({ data: [{ id: "c2", name: "Beta", country: "India" }] }) }));
vi.mock("@/components/features/banking/credit-pay-for-section", () => ({
  CreditPayForSection: (p: { relink?: unknown; pickedCustomerId?: string | null }) =>
    <div data-testid="payfor">{p.relink ? "relink" : "plain"} · {p.pickedCustomerId}</div>,
}));

import { RelinkOneOffDialog } from "./old-one-off-bookings";

afterEach(cleanup);

const txn = { id: "t1", bank_account_id: "b1", txn_date: "2026-10-12", description: "NEFT BETA", debit: 0, credit: 11800, reference: "U1" } as unknown as BankTransactionRow;
const booking = (o: Partial<OldOneOffBooking> = {}): OldOneOffBooking => ({
  txn_id: "t1", txn_date: "2026-10-12", amount: 11800, description: "NEFT BETA", payment_id: "p", receipt_voucher_no: "RV-3",
  received_on: "2026-10-12", quote_id: "Q-OLD", customer_id: "c2", customer_name: "Beta", product: "Google Workspace",
  invoice_id: "INV-4", invoice_status: "paid", invoice_date: "2026-10-12", invoice_amount: 11800, blocker: null, ...o,
});

describe("R-1863 RelinkOneOffDialog", () => {
  it("shows exactly what will happen, then the 'This money is for' step in relink mode with the old customer picked", () => {
    render(<RelinkOneOffDialog txn={txn} booking={booking()} canRelink onClose={() => {}} />);
    expect(screen.getByText("What will happen")).toBeTruthy();
    expect(screen.getByText(/Invoice INV-4 \(₹11,800, 12 Oct 2026\) gets a full credit note/)).toBeTruthy();
    expect(screen.getByTestId("payfor").textContent).toBe("relink · c2");
  });

  it("books locked: no relink step — says why and links Close month", () => {
    render(<RelinkOneOffDialog txn={txn} booking={booking({ blocker: "books_locked" })} canRelink onClose={() => {}} />);
    expect(screen.queryByTestId("payfor")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("The books are locked over this receipt");
    expect(screen.getByRole("button", { name: "Open Close month" }).closest("a")?.getAttribute("href")).toBe("/accounting/close");
  });

  it("a billing / manager login is told who can do it, nothing to press", () => {
    render(<RelinkOneOffDialog txn={txn} booking={booking()} canRelink={false} onClose={() => {}} />);
    expect(screen.queryByTestId("payfor")).toBeNull();
    expect(screen.getByRole("note").textContent).toContain("only an owner or accountant can do it");
  });
});
