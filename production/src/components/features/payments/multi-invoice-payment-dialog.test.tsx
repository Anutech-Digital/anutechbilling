// @vitest-environment jsdom
/* R-1525 — "Record payment — multiple invoices": the money typed once is spread oldest
   first, the left-over is shown as advance credit, and Save sends exactly those lines. */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

const mutate = vi.fn();
const push = vi.fn();
const toastErrorSpy = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastErrorSpy(...a), success: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
/* R-1730 owner example: the company has ONE bank account, HDFC ••0003. */
const HDFC_0003 = { id: "a3333333-3333-4333-8333-333333333333", name: "T-B3", bank_name: "HDFC Bank", account_number_last4: "0003", account_type: "current", is_active: true };
const bankData = [HDFC_0003];
vi.mock("@/lib/queries/bank", () => ({
  useBankAccounts: () => ({ data: bankData, isLoading: false }),
  useRecentDepositTags: () => ({ data: [] }),
}));
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
  push.mockReset();
  toastErrorSpy.mockReset();
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

    fireEvent.change(document.getElementById("mip_reference")!, { target: { value: "402312345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm payment" }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0][0]).toMatchObject({
      customerId: "c1",
      received: 4040,
      reference: "402312345678",
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
    fireEvent.change(document.getElementById("mip_reference")!, { target: { value: "402312345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm payment" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(mutate).not.toHaveBeenCalled();
  });

  it("R-1676: a UTR already on another payment → the refusal names it and offers that payment", async () => {
    render(<MultiInvoicePaymentDialog open onOpenChange={() => {}} customerId="c1" customerName="Acme" />);
    fireEvent.change(document.getElementById("mip_received")!, { target: { value: "1180" } });
    await waitFor(() => expect(lineValue(0)).toBe("1180"));
    fireEvent.change(document.getElementById("mip_reference")!, { target: { value: "402398765432" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm payment" }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    const msg = "Ye UTR pehle se RV-2026-27-0004 par hai — reference TESTUTR123456 is already recorded (T-7, ₹22939, 05 Oct 2026).";
    mutate.mock.calls[0][1].onError({
      message: msg, code: "P0001",
      details: "duplicate_payment_reference payment_id=11111111-2222-4333-8444-555555555555 customer_id=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });
    expect(toastErrorSpy).toHaveBeenCalledTimes(1);
    const [title, opts] = toastErrorSpy.mock.calls[0] as [string, { action?: { label: string; onClick: () => void } }];
    expect(title).toBe(msg);
    expect(opts.action?.label).toBe("Open that payment");
    opts.action!.onClick();
    expect(push).toHaveBeenCalledWith("/payments?customer=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  });

  /* R-1730 — the same defaults and words as the quote's Record payment sheet. */
  it("R-1730: opens with the customer's total due filled in (editable), like the quote sheet", async () => {
    render(<MultiInvoicePaymentDialog open onOpenChange={() => {}} customerId="c1" customerName="Acme" />);
    await waitFor(() => expect((document.getElementById("mip_received") as HTMLInputElement).value).toBe("4720"));
    expect([lineValue(0), lineValue(1), lineValue(2)]).toEqual(["1180", "2360", "1180"]);
    fireEvent.change(document.getElementById("mip_received")!, { target: { value: "1000" } });
    await waitFor(() => expect(lineValue(0)).toBe("1000"));
    expect((document.getElementById("mip_received") as HTMLInputElement).value).toBe("1000");
  });

  it("R-1730 owner example: one bank account HDFC ••0003 → 'Received in' already shows it", async () => {
    render(<MultiInvoicePaymentDialog open onOpenChange={() => {}} customerId="c1" customerName="Acme" />);
    await waitFor(() => expect(document.getElementById("mip_bank")!.textContent).toMatch(/0003/));
    expect(document.getElementById("mip_bank")!.textContent).not.toMatch(/Not sure yet/);
  });

  it("R-1730: the same field names as the quote sheet, English only", () => {
    render(<MultiInvoicePaymentDialog open onOpenChange={() => {}} customerId="c1" customerName="Acme" />);
    for (const label of ["Amount received (₹ — whole rupees)", "Payment method", "Received in", "Received on"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "Confirm payment" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Haan|lagao|karein/);
  });

  it("schema: a typed UPI reference must be 12 digits; any method may be blank (R-1444)", () => {
    const base = { customerId: "c1", received: 100, receivedDate: "2026-10-17", bankAccountId: "", excessToCredit: true, lines: [] };
    expect(multiInvoicePaymentSchema.safeParse({ ...base, method: "upi", reference: "abc" }).success).toBe(false);
    expect(multiInvoicePaymentSchema.safeParse({ ...base, method: "upi", reference: "402312345678" }).success).toBe(true);
    expect(multiInvoicePaymentSchema.safeParse({ ...base, method: "cash", reference: "" }).success).toBe(true);
    expect(multiInvoicePaymentSchema.safeParse({ ...base, method: "bank_transfer", reference: "" }).success).toBe(true);
    expect(multiInvoicePaymentSchema.safeParse({ ...base, method: "bank_transfer", reference: "dfg" }).success).toBe(false);
  });
});
