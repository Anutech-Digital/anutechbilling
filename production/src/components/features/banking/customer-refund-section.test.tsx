// @vitest-environment jsdom
/* R-2322 — Banking → Reconcile → a money-out line → Customer refund.
   Owner's example (R-2319 staging run, 31 Oct): a refund to a customer (Novoguild ₹41,832) on a
   money-out line had no customer-refund choice. Pick the customer (guessed from the narration), the
   credit note / advance being refunded (only ones that can take this line), the reason (prefilled),
   Save → reconcile_bank_debit_as_customer_refund with this line and that payment. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { BankTransactionRow } from "@/lib/queries/bank";
import type { RefundableItem } from "@/lib/banking/customer-refund";

const state = vi.hoisted(() => ({
  items: {} as Record<string, RefundableItem[]>,
  book: vi.fn(),
  asked: [] as Array<string | null>,
  asOf: [] as Array<string | null | undefined>,
}));
vi.mock("@/lib/banking/customer-refund-query", () => ({
  useCustomerRefundables: (id: string | null, asOf?: string | null) => { state.asked.push(id); state.asOf.push(asOf); return { data: id ? state.items[id] ?? [] : undefined, isLoading: false }; },
  useBookCustomerRefund: () => ({ mutateAsync: state.book, isPending: false }),
}));

import { CustomerRefundSection } from "./customer-refund-section";
import { MONEY_OUT_TILES } from "./reconcile-who-tiles";

const line = {
  id: "txn-1", debit: 41832, credit: 0, txn_date: "2026-10-31",
  description: "NEFT-HDFCN52026103100001-NOVOGUILD TECHNOLOGIES PVT LTD", bank_account_id: "acc-1",
} as unknown as BankTransactionRow;
const customers = [{ id: "c-novo", name: "Novoguild Technologies Pvt Ltd" }, { id: "c-acme", name: "Acme Corp" }];

beforeEach(() => {
  state.book.mockReset().mockResolvedValue({});
  state.asked = [];
  state.asOf = [];
  state.items = {
    "c-novo": [
      { payment_id: "p-small", kind: "credit_note", refundable: 5000, whole_only: false, invoice_id: "INV-1", credit_notes: "CN-1", voucher_no: "RV-1", received_on: "2026-08-01" },
      { payment_id: "p-cn", kind: "credit_note", refundable: 41832, whole_only: false, invoice_id: "INV-2", credit_notes: "CN-2", voucher_no: "RV-2", received_on: "2026-09-12" },
    ],
    "c-acme": [],
  };
});
afterEach(cleanup);

describe("Customer refund on a money-out line (R-2322)", () => {
  it("is a money-out tile", () => {
    expect(MONEY_OUT_TILES.find((t) => t.id === "customer")?.label).toBe("Customer refund");
  });

  it("guesses the customer, offers only what can take the line, prefills the reason, books this line", async () => {
    const onDone = vi.fn();
    render(<CustomerRefundSection transaction={line} customers={customers} onDone={onDone} />);
    expect((screen.getByLabelText("Customer refunded") as HTMLSelectElement).value).toBe("c-novo");

    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(radios[0].disabled).toBe(true);    // ₹5,000 credit cannot take a ₹41,832 line
    expect(screen.getByText("Only ₹5,000 can be refunded here — issue a credit note for the rest first.")).toBeTruthy();
    expect(radios[1].checked).toBe(true);
    expect((screen.getByLabelText("Refund reason") as HTMLInputElement).value).toBe("Refund of credit note CN-2 on INV-2");

    fireEvent.click(screen.getByRole("button", { name: /Book ₹41,832 as customer refund/ }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(state.book).toHaveBeenCalledWith({ transactionId: "txn-1", paymentId: "p-cn", reason: "Refund of credit note CN-2 on INV-2" });
  });

  it("a customer with nothing refundable says so and cannot save", () => {
    render(<CustomerRefundSection transaction={line} customers={customers} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("Customer refunded"), { target: { value: "c-acme" } });
    expect(screen.getByText(/no credit-note credit or unused advance to refund/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /as customer refund/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a too-short reason blocks Save", () => {
    render(<CustomerRefundSection transaction={line} customers={customers} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("Refund reason"), { target: { value: "ok" } });
    expect(screen.getByText("Write why the money went back (at least 5 characters).")).toBeTruthy();
    expect((screen.getByRole("button", { name: /as customer refund/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(state.book).not.toHaveBeenCalled();
  });

  /* R-2336 — owner's example (R-2322 localhost check, 1 Nov): the 7 Apr 2026 ₹500 line (UPI KUNAL GARG)
     offered and pre-picked E2E Customer's advances received 12 and 14 Jun 2026. */
  it("R-2336: advances that came in after the bank line are shown disabled with the reason, never pre-picked", () => {
    const apr = {
      id: "txn-apr", debit: 500, credit: 0, txn_date: "2026-04-07",
      description: "UPI-KUNAL GARG-9350568051", bank_account_id: "acc-1",
    } as unknown as BankTransactionRow;
    const late = (id: string, rv: string, d: string, label: string): RefundableItem => ({
      payment_id: id, kind: "advance", refundable: 500, whole_only: true, invoice_id: null, credit_notes: null, voucher_no: rv,
      received_on: d, dated_on: d, late_reason: `This advance came in on ${label}, after this bank line (7 Apr 2026).`,
    });
    state.items["c-e2e"] = [
      late("p-16", "RV-F588-27-0016", "2026-06-12", "12 Jun 2026"),
      late("p-19", "RV-F588-27-0019", "2026-06-14", "14 Jun 2026"),
    ];
    render(<CustomerRefundSection transaction={apr} customers={[...customers, { id: "c-e2e", name: "E2E Customer Pvt Ltd" }]} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("Customer refunded"), { target: { value: "c-e2e" } });

    expect(state.asOf.at(-1)).toBe("2026-04-07");
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(radios.every((r) => r.disabled && !r.checked)).toBe(true);
    expect(screen.getByText("This advance came in on 12 Jun 2026, after this bank line (7 Apr 2026).")).toBeTruthy();
    expect(screen.getByText("This advance came in on 14 Jun 2026, after this bank line (7 Apr 2026).")).toBeTruthy();
    expect(screen.queryByLabelText("Refund reason")).toBeNull();
    expect((screen.getByRole("button", { name: /as customer refund/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(state.book).not.toHaveBeenCalled();
  });
});
