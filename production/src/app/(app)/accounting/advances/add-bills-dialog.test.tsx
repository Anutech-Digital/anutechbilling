// @vitest-environment jsdom
/* R-1871 — Advances → Add bills. Owner examples:
     1. Ramesh holds ₹10,000; bills ₹4,130 (₹630 GST, Kapoor Stationers) + ₹2,370 travel →
        "Left with Ramesh Kumar ₹3,500"; the RPC gets both bills, vendor_id for the known vendor.
     2. ₹2,000 left, bill ₹3,200 → "Reimburse ₹1,200 to Ramesh Kumar" must be ticked to book. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const mutate = vi.fn();
vi.mock("@/lib/queries/employee-advance-bank", () => ({ useAddAdvanceBills: () => ({ mutate, isPending: false }) }));
vi.mock("@/lib/queries/vendors", () => ({ useVendors: () => ({ data: [{ id: "v1", name: "Kapoor Stationers", gstin: "07AABCK1234L1Z5" }] }) }));
vi.mock("@/lib/queries/vendor-bills", () => ({ uploadBillAttachment: vi.fn() }));
vi.mock("@/lib/dates/ist", () => ({ istToday: () => "2026-10-05" }));

import { AddBillsDialog } from "./add-bills-dialog";
import type { EmployeeAdvance } from "@/lib/queries/advances";

const adv = (left: number): EmployeeAdvance => ({
  id: "a1", tenant_id: "t", employee_id: null, employee_name: "Ramesh Kumar", disbursed_amount: 10000, disbursed_date: "2026-10-01",
  payment_method: "bank_transfer", bank_account_id: null, purpose: null, status: "active", notes: null, created_at: "", updated_at: "",
  total_spent: 10000 - left, remaining_balance: left, linked_expenses: [],
});

function fillBill(n: number, v: { vendor?: string; category: string; amount: string; gst?: string }) {
  const box = screen.getByRole("group", { name: `Bill ${n}` });
  if (v.vendor) fireEvent.change(within(box).getByLabelText(`Bill ${n} vendor`), { target: { value: v.vendor } });
  fireEvent.change(within(box).getByLabelText(`Bill ${n} category`), { target: { value: v.category } });
  fireEvent.change(within(box).getByLabelText(`Bill ${n} amount`), { target: { value: v.amount } });
  if (v.gst) fireEvent.change(within(box).getByLabelText(`Bill ${n} GST`), { target: { value: v.gst } });
}

afterEach(cleanup);
beforeEach(() => mutate.mockReset());

describe("R-1871 Add bills against an employee advance", () => {
  it("₹6,500 of bills on ₹10,000 → ₹3,500 left; both bills sent, known vendor linked", () => {
    render(<AddBillsDialog advance={adv(10000)} open onOpenChange={vi.fn()} />);
    fillBill(1, { vendor: "Kapoor Stationers", category: "Office Supplies", amount: "4,130", gst: "630" });
    fireEvent.click(screen.getByRole("button", { name: "Add another bill" }));
    fillBill(2, { vendor: "Ola", category: "Travel", amount: "2370" });
    expect(screen.getByText("Left with Ramesh Kumar").nextSibling?.textContent).toBe("₹3,500");
    expect(screen.queryByText(/Reimburse/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Book 2 bills (₹6,500)" }));
    expect(mutate).toHaveBeenCalledTimes(1);
    const arg = mutate.mock.calls[0][0];
    expect(arg.advanceId).toBe("a1");
    expect(arg.reimburseExtra).toBe(false);
    expect(arg.bills).toEqual([
      { date: "2026-10-05", vendor_name: "Kapoor Stationers", vendor_id: "v1", category: "Office Supplies", amount: 4130, gst: 630, bill_no: null, attachment_url: null, note: null },
      { date: "2026-10-05", vendor_name: "Ola", vendor_id: null, category: "Travel", amount: 2370, gst: 0, bill_no: null, attachment_url: null, note: null },
    ]);
  });

  it("bills over the balance: booking waits for 'Reimburse ₹1,200 to Ramesh Kumar'", () => {
    render(<AddBillsDialog advance={adv(2000)} open onOpenChange={vi.fn()} />);
    fillBill(1, { category: "Office Supplies", amount: "3200", gst: "480" });
    const book = screen.getByRole("button", { name: "Book 1 bill (₹3,200)" }) as HTMLButtonElement;
    expect(book.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Reimburse ₹1,200 to Ramesh Kumar/ }));
    expect(book.disabled).toBe(false);
    fireEvent.click(book);
    expect(mutate.mock.calls[0][0].reimburseExtra).toBe(true);
  });

  it("a GST equal to the bill, or paise, cannot be booked", () => {
    render(<AddBillsDialog advance={adv(10000)} open onOpenChange={vi.fn()} />);
    fillBill(1, { category: "Travel", amount: "500", gst: "500" });
    expect(screen.getByRole("alert").textContent).toMatch(/GST must be whole rupees and less than the bill amount/);
    fillBill(1, { category: "Travel", amount: "10.5", gst: "0" });
    expect(screen.getByRole("alert").textContent).toMatch(/whole rupees/);
    expect((screen.getByRole("button", { name: /Book 1 bill/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("salary is not a bill category here", () => {
    render(<AddBillsDialog advance={adv(10000)} open onOpenChange={vi.fn()} />);
    const opts = Array.from((screen.getByLabelText("Bill 1 category") as HTMLSelectElement).options).map((o) => o.value);
    expect(opts).not.toContain("Salaries");
    expect(opts).toContain("Office Supplies");
  });
});
