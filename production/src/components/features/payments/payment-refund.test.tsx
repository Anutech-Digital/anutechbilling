// @vitest-environment jsdom
/* R-1682 — after a cancel + credit note, the credit can be refunded (all or part, never more),
   and the Refund action exists on the card list too (not only the ≥1280px table). */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const rpc = vi.fn();
const toastSuccess = vi.fn();
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc }) }));
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: vi.fn(), info: vi.fn() } }));

import { PartialRefundDialog, refundRoute } from "./payment-refund";

beforeEach(() => { rpc.mockReset(); toastSuccess.mockReset(); });
afterEach(cleanup);

describe("R-1682 refundRoute", () => {
  it("staging T-19: ₹7,646 paid, ₹6,372 credit note → offer the ₹6,372 (not 'credit note first')", () => {
    expect(refundRoute({ cash: 7646, ownOpenCredit: 0, creditNoteCredit: 6372 })).toEqual({ kind: "partial", max: 6372, credit: 6372, gap: 1274 });
  });
  it("credit notes cover the whole payment → the ordinary full refund", () => {
    expect(refundRoute({ cash: 7646, ownOpenCredit: 0, creditNoteCredit: 7646 })).toEqual({ kind: "full", cover: 7646 });
  });
  it("no credit note at all → credit note first", () => {
    expect(refundRoute({ cash: 7646, ownOpenCredit: 0, creditNoteCredit: 0 })).toMatchObject({ kind: "credit_note_first", need: 7646 });
  });
});

function renderDialog(onOpenChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <PartialRefundDialog open onOpenChange={onOpenChange} payment={{ id: "pay-1", amount: 7646, quote_id: "Q-1" }}
        invoiceId="INV-5F40-27-0079" max={6372} credit={6372} />
    </QueryClientProvider>,
  );
  return onOpenChange;
}

describe("R-1682 PartialRefundDialog", () => {
  it("defaults to the whole open credit and sends it with the reason", async () => {
    rpc.mockResolvedValue({ data: { refund_voucher_no: "RFV-1", amount: 6372, split: true, kept_amount: 1274 }, error: null });
    const onOpenChange = renderDialog();
    expect((document.getElementById("partial-refund-amount") as HTMLInputElement).value).toBe("6372");
    const book = screen.getByRole("button", { name: /Book refund/ }) as HTMLButtonElement;
    expect(book.disabled).toBe(true); // no reason yet
    fireEvent.change(document.getElementById("partial-refund-reason")!, { target: { value: "Subscription cancelled" } });
    fireEvent.click(screen.getByRole("button", { name: "Book refund ₹6,372" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect(rpc.mock.calls[0]).toEqual(["refund_credit_note_credit", { p_payment_id: "pay-1", p_amount: 6372, p_reason: "Subscription cancelled" }]);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toastSuccess.mock.calls[0][0]).toBe("Refund booked — voucher RFV-1");
  });

  it("more than the credit cannot be booked", async () => {
    renderDialog();
    fireEvent.change(document.getElementById("partial-refund-amount")!, { target: { value: "7000" } });
    fireEvent.change(document.getElementById("partial-refund-reason")!, { target: { value: "Subscription cancelled" } });
    expect(screen.getByText(/At most ₹6,372 can be refunded/)).toBeTruthy();
    const book = screen.getByRole("button", { name: /Book refund/ }) as HTMLButtonElement;
    expect(book.disabled).toBe(true);
    fireEvent.click(book);
    await new Promise((r) => setTimeout(r, 20));
    expect(rpc).not.toHaveBeenCalled();
  });
});
