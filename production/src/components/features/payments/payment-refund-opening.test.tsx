// @vitest-environment jsdom
/* R-1747 — Refund on a payment recorded on an invoice imported from Zoho Books (R-1739):
   payments.quote_id NULL, payments.invoice_id set. Owner's example: ₹15,000 on INV-000245.
   The flow used to take the invoice from the quote only (null here), title the dialog
   "Refund ₹15,000 on null?" and say "the quote/subscription balance reopens". An imported
   invoice cannot take a credit note here, so the refund is a plain one that reopens the
   invoice's balance — and the screen says so. */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const rpc = vi.fn();
const from = vi.fn();
const confirm = vi.fn();
const askText = vi.fn();
const toastSuccess = vi.fn();
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc, from }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => confirm, useAskText: () => askText }));
vi.mock("@/components/features/subscriptions/cancel-subscription-dialog", () => ({ CancelSubscriptionDialog: () => null }));
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: vi.fn(), info: vi.fn() } }));

import { PaymentRefundButton } from "./payment-refund";
import type { Payment } from "@/lib/supabase/database.types";

const payment = {
  id: "pay-245", quote_id: null, invoice_id: "INV-000245", customer_id: "c-tabc", amount: 15000, credit_applied: 0,
  status: "received", method: "bank_transfer", reference: "UTR-1", received_at: "2026-10-21T00:00:00Z",
  receipt_voucher_no: "RV-TZA-27-0009",
} as unknown as Payment;

beforeEach(() => { rpc.mockReset(); from.mockReset(); confirm.mockReset(); askText.mockReset(); toastSuccess.mockReset(); });
afterEach(cleanup);

function renderButton(p: Payment = payment) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <PaymentRefundButton payment={p} invoiceId="INV-000245" invoiceNumber="INV-000245" />
    </QueryClientProvider>,
  );
}

describe("R-1747 refund of a payment on an imported Zoho invoice", () => {
  it("owner's example: says it is an opening-balance invoice, no credit note, the balance reopens — then a plain refund", async () => {
    askText.mockResolvedValue("Customer paid twice");
    confirm.mockResolvedValue(true);
    rpc.mockResolvedValue({ data: { refund_voucher_no: "RFV-TZA-27-0001", amount: 15000, opening_invoice: true, invoice_number: "INV-000245", invoice_due_after: 20000 }, error: null });
    renderButton();
    const btn = screen.getByRole("button", { name: "Refund payment" });   // not "Refund (credit note)"
    fireEvent.click(btn);
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));

    // never the credit-note route: no credit lookup, no "Credit note first"
    expect(from).not.toHaveBeenCalled();
    expect(askText.mock.calls[0][0].title).toBe("Refund ₹15,000 on invoice INV-000245?");
    const c = confirm.mock.calls[0][0];
    expect(c.title).toBe("Refund ₹15,000 on invoice INV-000245?");
    expect(c.body).toContain("INV-000245 is an opening-balance invoice imported from Zoho Books");
    expect(c.body).toContain("No credit note is made here");
    expect(c.body).toContain("₹15,000 becomes due again on INV-000245");
    expect(c.body).not.toMatch(/quote|subscription/i);
    expect(c.confirmLabel).toBe("Book refund");

    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect(rpc.mock.calls[0]).toEqual(["refund_payment", { p_payment_id: "pay-245", p_reason: "Customer paid twice" }]);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastSuccess.mock.calls[0][0]).toBe("Refund booked — voucher RFV-TZA-27-0001");
    expect(toastSuccess.mock.calls[0][1].description).toContain("INV-000245 has ₹20,000 due again");
  });

  it("the payment's own invoice_id decides — even if the caller passes no invoice number", async () => {
    askText.mockResolvedValue(null);
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <PaymentRefundButton payment={payment} invoiceId={null} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Refund payment" }));
    await waitFor(() => expect(askText).toHaveBeenCalledTimes(1));
    expect(askText.mock.calls[0][0].title).toBe("Refund ₹15,000 on invoice INV-000245?");
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});
