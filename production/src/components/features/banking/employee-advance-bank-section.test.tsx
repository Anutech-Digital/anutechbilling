// @vitest-environment jsdom
/* R-1871 — Banking → Reconcile → employee office-expense advance. Owner examples:
     1. ₹10,000 debit "UPI/RAMESH KUMAR/office exp", Ramesh holds no advance → "Book ₹10,000 as
        advance to Ramesh Kumar" sends kind give + his name.
     2. ₹2,000 debit, Ramesh already holds ₹500 → top-up of that advance is pre-picked, says ₹2,500.
     3. ₹3,500 credit → Ramesh's advance with exactly ₹3,500 is pre-picked, "settled — ₹0 left".
     4. ₹1,200 debit with a pending ₹1,200 reimbursement → "Book ₹1,200 as reimbursement paid". */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { BankTransactionRow } from "@/lib/queries/bank";

const mutateAsync = vi.fn();
const employees = [
  { id: "e1", name: "Ramesh Kumar", is_active: true },
  { id: "e2", name: "Suresh Pal", is_active: true },
];
let advances: Array<{ id: string; employee_name: string; status: string; remaining_balance: number; disbursed_date: string }> = [];
let pending: Array<{ id: string; person_name: string; amount: number; incurred_on: string; purpose: string; employee_id: string | null }> = [];

vi.mock("@/lib/queries/payroll", () => ({ useEmployees: () => ({ data: employees }) }));
vi.mock("@/lib/queries/advances", () => ({ useEmployeeAdvances: () => ({ data: advances }) }));
vi.mock("@/lib/queries/employee-advance-bank", () => ({
  useBookBankTxnAsEmployeeAdvance: () => ({ mutateAsync, isPending: false }),
  usePendingReimbursements: () => ({ data: pending }),
}));

import { EmployeeAdvanceBankSection } from "./employee-advance-bank-section";

const txn = (over: Partial<BankTransactionRow> = {}): BankTransactionRow => ({
  id: "t1", tenant_id: "x", bank_account_id: "acc-1", txn_date: "2026-10-01", description: "UPI/RAMESH KUMAR/office exp",
  debit: 10000, credit: 0, balance_after: null, reference: null, source: "csv_upload",
  matched_to_type: null, matched_to_id: null, matched_at: null, matched_by: null, match_confidence: null,
  imported_at: "", created_at: "", updated_at: "", ...over,
} as BankTransactionRow);

afterEach(cleanup);
beforeEach(() => { mutateAsync.mockReset(); mutateAsync.mockResolvedValue({}); advances = []; pending = []; });

describe("R-1871 employee advance from a bank line", () => {
  it("money-out, no advance held: a new advance to the person named in the narration", async () => {
    const done = vi.fn();
    render(<EmployeeAdvanceBankSection transaction={txn()} onDone={done} />);
    expect(screen.getByText("Advance to employee (office expenses)?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Book advance" }));
    expect((screen.getByLabelText("Employee") as HTMLSelectElement).value).toBe("Ramesh Kumar");
    expect(screen.getByText(/₹10,000 will be with Ramesh Kumar/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Purpose (optional)"), { target: { value: "October office" } });
    fireEvent.click(screen.getByRole("button", { name: "Book ₹10,000 as advance to Ramesh Kumar" }));
    await vi.waitFor(() => expect(done).toHaveBeenCalled());
    expect(mutateAsync).toHaveBeenCalledWith({ transactionId: "t1", kind: "give", name: "Ramesh Kumar", note: "October office" });
  });

  it("money-out, advance already held: top-up is pre-picked and the new balance shown", async () => {
    advances = [{ id: "a1", employee_name: "Ramesh Kumar", status: "active", remaining_balance: 500, disbursed_date: "2026-09-01" }];
    render(<EmployeeAdvanceBankSection transaction={txn({ debit: 2000 })} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Book advance" }));
    expect((screen.getByRole("radio", { name: /Top up their open advance \(₹500 with them now\)/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/₹2,500 will be with Ramesh Kumar/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Book ₹2,000 as top-up" }));
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ transactionId: "t1", kind: "top_up", advanceId: "a1" }));
  });

  it("money-in: the advance with exactly that balance is pre-picked and settles", async () => {
    advances = [
      { id: "a1", employee_name: "Ramesh Kumar", status: "active", remaining_balance: 3500, disbursed_date: "2026-10-01" },
      { id: "a2", employee_name: "Suresh Pal", status: "active", remaining_balance: 900, disbursed_date: "2026-10-02" },
    ];
    render(<EmployeeAdvanceBankSection transaction={txn({ debit: 0, credit: 3500, description: "NEFT CR 99 RETURN" })} onDone={vi.fn()} />);
    expect(screen.getByText("Advance returned by employee?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Book return" }));
    expect((screen.getByLabelText("Employee advance") as HTMLSelectElement).value).toBe("a1");
    expect(screen.getByText(/advance is settled — ₹0 left with them/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Book ₹3,500 as advance returned" }));
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ transactionId: "t1", kind: "return", advanceId: "a1" }));
  });

  it("money-in more than the balance: refused on screen", () => {
    advances = [{ id: "a2", employee_name: "Suresh Pal", status: "active", remaining_balance: 900, disbursed_date: "2026-10-02" }];
    render(<EmployeeAdvanceBankSection transaction={txn({ debit: 0, credit: 1500, description: "UPI/SURESH PAL/back" })} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Book return" }));
    expect((screen.getByLabelText("Employee advance") as HTMLSelectElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Employee advance"), { target: { value: "a2" } });
    expect(screen.getByText(/Only ₹900 is with Suresh Pal/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /as advance returned/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("money-in with no open advance: nothing shown", () => {
    const { container } = render(<EmployeeAdvanceBankSection transaction={txn({ debit: 0, credit: 3500 })} onDone={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });

  it("money-out matching a pending reimbursement: pays it", async () => {
    pending = [{ id: "r1", person_name: "Ramesh Kumar", amount: 1200, incurred_on: "2026-10-15", purpose: "Office expenses over the advance", employee_id: "e1" }];
    render(<EmployeeAdvanceBankSection transaction={txn({ debit: 1200 })} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Book reimbursement" }));
    expect((screen.getByLabelText("Reimbursement") as HTMLSelectElement).value).toBe("r1");
    fireEvent.click(screen.getByRole("button", { name: "Book ₹1,200 as reimbursement paid" }));
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ transactionId: "t1", kind: "reimburse", reimbursementId: "r1" }));
  });
});
