// @vitest-environment jsdom
/* R-1711 — a cancel never clears a due an open GST invoice still asks for; the dialog offers the
   credit note on that invoice instead (CGST s.34). */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const mutate = vi.fn();
let invoices: unknown[] = [];
vi.mock("@/lib/queries/subscriptions", () => ({
  useCancelSubscription: () => ({ mutate, isPending: false }),
  useSubscriptionInvoices: () => ({ data: invoices, isLoading: false, isError: false }),
}));
vi.mock("@/components/features/invoices/issue-credit-note-dialog", () => ({
  IssueCreditNoteDialog: (p: { open: boolean; invoiceId: string; amountDue: number; defaultReasonCode?: string }) =>
    p.open ? <div data-testid="cn">{`${p.invoiceId} ${p.amountDue} ${p.defaultReasonCode}`}</div> : null,
}));

import { CancelSubscriptionDialog } from "./cancel-subscription-dialog";

const SUB = {
  id: "sub-a1", customer_name: "T-A1", plan: "Business Plus", outstanding_amount: 18232,
  start_date: "2026-10-01", quote_id: "Q-1", renewal_quote_id: null,
};
const INV = {
  id: "INV-0013", status: "pending", amount: 18232, net_payable: 18232, paid_amount: 0, written_off_at: null,
  customer_name: "T-A1", tax_rate: 18, inter_state: false, invoice_date: "2026-10-20",
};

function fillAndConfirm() {
  fireEvent.change(document.getElementById("cancel-sub-reason")!, { target: { value: "Customer moved away" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel subscription" }));
}

beforeEach(() => { mutate.mockReset(); invoices = []; });
afterEach(cleanup);

describe("R-1711 CancelSubscriptionDialog", () => {
  it("open invoice holds the whole due → no 'Clear' box, a credit-note button for that invoice", () => {
    invoices = [INV];
    render(<CancelSubscriptionDialog sub={SUB} open onOpenChange={vi.fn()} clearDueDefault />);
    expect(screen.queryByText(/Clear the/)).toBeNull();
    expect(screen.getByText(/INV-0013/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Issue credit note for the unused part/ }));
    expect(screen.getByTestId("cn").textContent).toBe("INV-0013 18232 cancellation");
  });

  it("…and the cancel never asks the server to clear it, even when the refund flow pre-ticks it", () => {
    invoices = [INV];
    render(<CancelSubscriptionDialog sub={SUB} open onOpenChange={vi.fn()} clearDueDefault />);
    fillAndConfirm();
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toMatchObject({ id: "sub-a1", clearDue: false });
  });

  it("part on the invoice → the Clear box offers only the rest", () => {
    invoices = [{ ...INV, amount: 10000, net_payable: 10000 }];
    render(<CancelSubscriptionDialog sub={SUB} open onOpenChange={vi.fn()} clearDueDefault />);
    expect(screen.getByText(/Clear the ₹8,232 not on any invoice/)).toBeTruthy();
    fillAndConfirm();
    expect(mutate.mock.calls[0][0]).toMatchObject({ clearDue: true });
  });

  it("no invoice (postpaid) → the R-455 Clear box, as before", () => {
    render(<CancelSubscriptionDialog sub={{ ...SUB, outstanding_amount: 956 }} open onOpenChange={vi.fn()} />);
    expect(screen.getByText(/Clear the ₹956 still shown as due/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Issue credit note/ })).toBeNull();
  });
});
