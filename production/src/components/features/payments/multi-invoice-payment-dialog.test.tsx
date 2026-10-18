// @vitest-environment jsdom
/* R-1525 — "Record payment — multiple invoices": the money typed once is spread oldest
   first, the left-over is shown as advance credit, and Save sends exactly those lines. */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

const mutate = vi.fn();
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/queries/bank", () => ({ useBankAccounts: () => ({ data: [] }) }));
vi.mock("@/components/features/customers/customer-combobox", () => ({ CustomerCombobox: () => null }));
vi.mock("@/lib/queries/payments", () => {
  const result = {
    isLoading: false,
    error: null,
    data: [
      { id: "INV-3", invoice_date: "2026-09-01", due_date: null, amount: 1180, net_payable: 1180, paid_amount: 0, status: "pending", tax_rate: 18, quote_id: "Q3" },
      { id: "INV-1", invoice_date: "2026-07-01", due_date: null, amount: 1180, net_payable: 1180, paid_amount: 0, status: "pending", tax_rate: 18, quote_id: "Q1" },
      { id: "INV-2", invoice_date: "2026-08-01", due_date: null, amount: 2360, net_payable: 2360, paid_amount: 0, status: "pending", tax_rate: 18, quote_id: "Q2" },
    ],
  };
  /* Same object every render, as react-query gives. */
  return {
    useCustomerOpenInvoices: () => result,
    useRecordMultiInvoicePayment: () => ({ mutate, isPending: false }),
  };
});

import { MultiInvoicePaymentDialog, multiInvoicePaymentSchema } from "./multi-invoice-payment-dialog";

beforeEach(() => {
  mutate.mockReset();
  /* Radix Checkbox measures itself; jsdom has no ResizeObserver. */
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const lineValue = (i: number) => (document.getElementById(`mip_line_${i}`) as HTMLInputElement).value;

describe("R-1525 multi-invoice payment sheet", () => {
  it("spreads the received amount oldest first and sends those lines", async () => {
    render(<MultiInvoicePaymentDialog open onOpenChange={() => {}} customerId="c1" customerName="Acme" />);
    expect(screen.getByText(/Open invoices · 3 · ₹4,720 due/)).toBeTruthy();

    fireEvent.change(document.getElementById("mip_received")!, { target: { value: "4040" } });
    await waitFor(() => expect(lineValue(2)).toBe("500"));
    expect([lineValue(0), lineValue(1)]).toEqual(["1180", "2360"]);

    fireEvent.change(document.getElementById("mip_reference")!, { target: { value: "UTR402312345678" } });
    fireEvent.click(screen.getByRole("button", { name: /Record ₹4,040/ }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0][0]).toMatchObject({
      customerId: "c1",
      received: 4040,
      reference: "UTR402312345678",
      excessToCredit: true,
      allocations: [
        { invoice_id: "INV-1", amount: 1180 },
        { invoice_id: "INV-2", amount: 2360 },
        { invoice_id: "INV-3", amount: 500 },
      ],
    });
  });

  it("more than all dues → every invoice full and the rest shown as advance credit", async () => {
    render(<MultiInvoicePaymentDialog open onOpenChange={() => {}} customerId="c1" customerName="Acme" />);
    fireEvent.change(document.getElementById("mip_received")!, { target: { value: "5000" } });
    await waitFor(() => expect(lineValue(2)).toBe("1180"));
    expect(screen.getByText(/Left over → advance credit/)).toBeTruthy();
    expect(screen.getByText(/Keep ₹280 as the customer's advance credit/)).toBeTruthy();
  });

  it("a line above its due is refused before Save, with the fix", async () => {
    render(<MultiInvoicePaymentDialog open onOpenChange={() => {}} customerId="c1" customerName="Acme" />);
    fireEvent.change(document.getElementById("mip_received")!, { target: { value: "1500" } });
    await waitFor(() => expect(lineValue(0)).toBe("1180"));
    fireEvent.change(document.getElementById("mip_line_0")!, { target: { value: "1500" } });
    fireEvent.change(document.getElementById("mip_line_1")!, { target: { value: "0" } });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/INV-1 gets more than its due/));
    fireEvent.change(document.getElementById("mip_reference")!, { target: { value: "UTR402312345678" } });
    fireEvent.click(screen.getByRole("button", { name: /Record ₹1,500/ }));
    await new Promise((r) => setTimeout(r, 50));
    expect(mutate).not.toHaveBeenCalled();
  });

  it("schema: a UPI reference must be 12 digits; cash may be blank", () => {
    const base = { customerId: "c1", received: 100, receivedDate: "2026-10-17", bankAccountId: "", excessToCredit: true, lines: [] };
    expect(multiInvoicePaymentSchema.safeParse({ ...base, method: "upi", reference: "abc" }).success).toBe(false);
    expect(multiInvoicePaymentSchema.safeParse({ ...base, method: "upi", reference: "402312345678" }).success).toBe(true);
    expect(multiInvoicePaymentSchema.safeParse({ ...base, method: "cash", reference: "" }).success).toBe(true);
    expect(multiInvoicePaymentSchema.safeParse({ ...base, method: "bank_transfer", reference: "" }).success).toBe(false);
  });
});
