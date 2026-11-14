// @vitest-environment jsdom
/* R-2771 — Edit salary from the Salary Register / Payroll: the Pay salary form in edit mode.
   Booked October 2026 for a ₹30,000 employee: gross 30,000, 1 day LOP ₹968, bonus ₹2,000 + arrears
   ₹6,000 (incentive 8,000), advance ₹5,000 from loan-1, TDS 500, PF 1,800 → net 29,732. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const calls: string[] = [];
let payArgs: Record<string, unknown> | null = null;
let payFails = false;
let undoFails = false;
/* What the server says once delete_salary_payment has run: the arrears and the advance are free again. */
let undone = false;
let arrearsOverride: Record<string, unknown> | null = null;
let history: Record<string, unknown>[] = [];
const refresh = vi.fn();
const toastSuccess = vi.fn();

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: (...a: unknown[]) => toastSuccess(...a), error: vi.fn() }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams("") }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "owner" } }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/queries/bank", () => ({
  useBankAccounts: () => ({ data: [
    { id: "acct-cash", name: "Petty Cash", is_active: true, account_type: "cash" },
    { id: "acct-hdfc", name: "HDFC Current", is_active: true, account_type: "current" },
    { id: "acct-icici", name: "ICICI Current", is_active: true, account_type: "current" },
  ] }),
}));
vi.mock("@/lib/queries/employee-loans", () => ({
  // The loan this salary recovered from is now fully repaid (closed) — the edit must still offer it.
  useEmployeeLoans: () => ({ data: [undone
    ? { id: "loan-1", status: "active", outstanding: 5000, employee_name: "Asha Rani" }
    : { id: "loan-1", status: "closed", outstanding: 0, employee_name: "Asha Rani" }] }),
}));
vi.mock("@/lib/queries/attendance-shift", () => ({ useShiftRules: () => ({ data: undefined }) }));
vi.mock("@/lib/queries/payroll", async (orig) => ({
  ...(await orig<typeof import("@/lib/queries/payroll")>()),
  useSalaryArrears: () => ({ data: arrearsOverride ?? { due: 6000, paid: undone ? 0 : 6000, outstanding: undone ? 6000 : 0, overpaid: 0, months: [{ period: "2026-09", arrears: 6000 }], monthsLabel: "Sep 2026", lastMonth: "2026-09" } }),
  useAttendance: () => ({ data: [] }),
  useLeaveEntries: () => ({ data: [] }),
  useHolidays: () => ({ data: [] }),
  useEmployeeSalaryHistory: () => ({ data: history }),
  usePaySalary: (opts?: { quiet?: boolean }) => ({
    isPending: false,
    mutateAsync: async (input: Record<string, unknown>) => {
      calls.push(`pay quiet=${Boolean(opts?.quiet)}`);
      payArgs = input;
      if (payFails) throw new Error("bank account missing");
    },
  }),
  useDeleteSalaryPayment: (opts?: { quiet?: boolean; hold?: boolean }) => ({
    isPending: false,
    mutateAsync: async (id: string) => {
      calls.push(`undo ${id} quiet=${Boolean(opts?.quiet)} hold=${Boolean(opts?.hold)}`);
      if (undoFails) throw new Error("reconciled");
      undone = true;
    },
  }),
  useRefreshSalaryData: () => refresh,
}));

import { PaySalaryDialog } from "./screens";

const employee = {
  id: "emp-asha", name: "Asha Rani", monthly_gross: 30000, basic_monthly: 15000, da_monthly: 0,
  pf_applicable: true, pf_full_wage: false, esi_applicable: false, joining_date: "2026-01-01", exit_date: null,
} as never;
const booked: Record<string, unknown> = {
  id: "sal-oct", employee_id: "emp-asha", period: "2026-10", pay_date: "2026-10-31", gross: 30000, lop_days: 1, lop_amount: 968,
  incentive: 8000, arrears: 6000, advance_recovered: 5000, advance_loan_id: "loan-1", tds: 500, pf: 1800, esi: 0,
  pf_employer: 1800, esi_employer: 0, pf_wage: 15000, other_deduction: 0, bank_account_id: "acct-icici",
  net: 29732, paid_amount: 0, paid_status: "unpaid", salary_in_force: 30000, notes: "LOP 1 day — absent 14 Oct",
};

const val = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value;
let row: Record<string, unknown> = {};
const open = (onClose = vi.fn()) => {
  render(<PaySalaryDialog employee={employee} period="2026-10" revisions={[]} editing={{ ...booked, ...row } as never} onClose={onClose} />);
  return onClose;
};

beforeEach(() => { history = [booked as never]; });
afterEach(() => {
  cleanup(); calls.length = 0; payArgs = null; payFails = false; undoFails = false; undone = false; arrearsOverride = null; row = {}; refresh.mockReset(); toastSuccess.mockReset();
});

describe("R-2771 Pay salary form in edit mode", () => {
  it("edit prefills booked figures — every field of THAT month, nothing auto-overwritten", async () => {
    open();
    expect(screen.getByRole("dialog", { name: "Edit salary — Asha Rani" })).toBeTruthy();
    await waitFor(() => expect(val("payroll-salary-to-pay")).toBe("30000"));
    expect(val("payroll-bonus-incentive")).toBe("2000");
    expect(val("payroll-arrears")).toBe("6000");
    expect(val("payroll-unpaid-leave-lop-days")).toBe("1");
    expect(val("payroll-lop-amount")).toBe("968");
    expect(val("payroll-advance-recovery")).toBe("5000");
    expect(val("payroll-from-advance")).toBe("loan-1");
    expect(val("payroll-tds")).toBe("500");
    expect(val("payroll-pf-employee")).toBe("1800");
    expect(val("payroll-esi-employee")).toBe("0");
    expect(val("payroll-other")).toBe("0");
    expect(val("payroll-pay-date")).toBe("2026-10-31");
    expect(val("payroll-pay-from")).toBe("acct-icici");
    expect(screen.getByRole("button", { name: /^Save ₹29,732$/ })).toBeTruthy();
    expect(screen.queryByText(/^Max /)).toBeNull(); // arrears + advance of this very run are allowed again
  });

  it("cancel edit keeps the salary — no RPC runs, nothing to refresh", () => {
    const onClose = open();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    cleanup();
    expect(calls).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("Gross +1,000 → Save: undo (held) then pay with the booked PF / ESI / TDS, employer shares and PF wage; net +1,000", async () => {
    const onClose = open();
    fireEvent.change(document.getElementById("payroll-salary-to-pay")!, { target: { value: "31000" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save ₹30,732$/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls).toEqual(["undo sal-oct quiet=true hold=true", "pay quiet=true"]);
    expect(payArgs).toEqual({
      employeeId: "emp-asha", period: "2026-10", payDate: "2026-10-31", gross: 31000, lopDays: 1, lopAmount: 968,
      incentive: 2000, advanceRecovered: 5000, advanceLoanId: "loan-1", tds: 500, pf: 1800, esi: 0, esiEmployer: 0,
      pfEmployer: 1800, other: 0, bankAccountId: "acct-icici", pfWage: 15000, arrears: 6000,
      notes: "LOP 1 day — absent 14 Oct",
    });
    expect(toastSuccess).toHaveBeenCalledWith("Salary for October 2026 changed", expect.anything());
    cleanup();
    expect(refresh).not.toHaveBeenCalled(); // the pay's own success re-reads everything
  });

  it("a hand-changed PF takes the worked-out employer share and PF wage — never the booked ones", async () => {
    const onClose = open();
    fireEvent.change(document.getElementById("payroll-pf-employee")!, { target: { value: "1742" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save ₹/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // 12% of Basic 15,000 prorated for the LOP day (29,032 / 30,000 → wage 14,516).
    expect(payArgs).toMatchObject({ pf: 1742, pfEmployer: 1742, pfWage: 14516 });
  });

  it("the form shows no Pay-mode proration text for a booked figure", () => {
    open();
    expect(screen.queryByText(/Prorated to/)).toBeNull();
    expect(screen.queryByText(/isn.t over yet/)).toBeNull();
  });

  it("rev-r2771 #4 — month revised after it was booked and its arrears ALREADY PAID with a later salary: no 'Pay at the revised salary' (the raise would be paid twice), says why", () => {
    row = { arrears: 0, incentive: 2000 };
    arrearsOverride = { due: 3000, paid: 3000, outstanding: 0, overpaid: 0, months: [{ period: "2026-10", arrears: 3000 }], monthsLabel: "Oct 2026", lastMonth: "2026-10" };
    render(<PaySalaryDialog employee={{ ...(employee as object), monthly_gross: 33000, basic_monthly: 16500 } as never} period="2026-10" revisions={[]} editing={{ ...booked, ...row } as never} onClose={vi.fn()} />);
    const note = screen.getByTestId("edit-salary-revised-since");
    expect(screen.queryByRole("button", { name: /Pay at the revised salary/ })).toBeNull();
    expect(note.textContent).toMatch(/revision arrears were already paid with a later salary — keep the booked salary/);
  });

  it("month revised after it was booked (30,000 → 33,000), arrears still due: says arrears stop, one click pays at the revised salary", async () => {
    row = { arrears: 0, incentive: 2000 };
    arrearsOverride = { due: 3000, paid: 0, outstanding: 3000, overpaid: 0, months: [{ period: "2026-10", arrears: 3000 }], monthsLabel: "Oct 2026", lastMonth: "2026-10" };
    render(<PaySalaryDialog employee={{ ...(employee as object), monthly_gross: 33000, basic_monthly: 16500 } as never} period="2026-10" revisions={[]} editing={{ ...booked, ...row } as never} onClose={vi.fn()} />);
    const note = screen.getByTestId("edit-salary-revised-since");
    expect(note.textContent).toMatch(/booked at ₹30,000\/month.*revised to ₹33,000\/month/);
    expect(note.textContent).toMatch(/revision arrears for October 2026 will not be offered/);
    fireEvent.click(screen.getByRole("button", { name: "Pay at the revised salary (₹33,000)" }));
    await waitFor(() => expect(val("payroll-salary-to-pay")).toBe("33000"));
  });

  it("incentive-only run (gross 0) can be saved as such", async () => {
    row = { gross: 0, lop_days: 0, lop_amount: 0, incentive: 8000, arrears: 0, advance_recovered: 0, advance_loan_id: null, tds: 0, pf: 0, pf_employer: 0, pf_wage: null, net: 8000 };
    const onClose = open();
    fireEvent.click(screen.getByRole("button", { name: /^Save ₹8,000$/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(payArgs).toMatchObject({ gross: 0, incentive: 8000, pf: 0, pfEmployer: 0 });
  });

  it("undo refused (linked meanwhile) → nothing booked, form stays, no removed warning", async () => {
    undoFails = true;
    const onClose = open();
    fireEvent.click(screen.getByRole("button", { name: /^Save ₹/ }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatch(/^undo sal-oct/);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId("edit-salary-old-removed")).toBeNull();
  });

  it("pay fails after undo keeps the form: says the month has no salary; Save again only books", async () => {
    payFails = true;
    const onClose = open();
    fireEvent.click(screen.getByRole("button", { name: /^Save ₹/ }));
    await waitFor(() => expect(screen.getByTestId("edit-salary-old-removed").textContent).toMatch(/old salary for October 2026 was removed/));
    expect(onClose).not.toHaveBeenCalled();
    payFails = false;
    calls.length = 0;
    fireEvent.click(screen.getByRole("button", { name: /^Save ₹/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls).toEqual(["pay quiet=true"]); // no second undo
  });

  it("closing after a failed re-book refreshes the lists (the month now shows as not booked)", async () => {
    payFails = true;
    open();
    fireEvent.click(screen.getByRole("button", { name: /^Save ₹/ }));
    await waitFor(() => expect(screen.getByTestId("edit-salary-old-removed")).toBeTruthy());
    cleanup();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("recalculate excludes own row: auto TDS / PF come back and the booked month is not counted as an earlier one", async () => {
    open();
    expect(screen.getByTestId("edit-salary-kept-statutory").textContent).toMatch(/kept as booked for October 2026/);
    fireEvent.click(screen.getByRole("button", { name: "Recalculate PF / ESI / TDS" }));
    await waitFor(() => expect(screen.queryByTestId("edit-salary-kept-statutory")).toBeNull());
    // ₹30,000 a month is far under the s.87A limit → auto TDS 0 (the booked 500 was a manual figure).
    await waitFor(() => expect(val("payroll-tds")).toBe("0"));
    // PF back to auto: 12% of Basic 15,000 prorated for the 1 LOP day (29,032 / 30,000) = 1,742.
    expect(val("payroll-pf-employee")).toBe("1742");
  });
});
