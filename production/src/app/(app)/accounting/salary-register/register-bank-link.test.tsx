// @vitest-environment jsdom
/* R-1895 — the owner's path (staging, 25 Oct): Salary Register → Sajan Singh Negi → click the
   Apr 2026 row (₹1,05,000, paid 21 May 2026) → the bank statement opens on that line.
   Sep 2026 "Not paid yet" is not a link; a Paid month with no bank line says so, with Match. */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams("employee=emp-sajan"),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "owner" } }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("../payroll/screens", () => ({ HrPageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

const pay = (o: Record<string, unknown>) => ({
  employee_id: "emp-sajan", gross: 105000, incentive: 0, lop_amount: 0, tds: 0, pf: 0, esi: 0, other_deduction: 0,
  expense_id: null, ...o,
});
const rows = [
  pay({ id: "sal-apr", period: "2026-04", pay_date: "2026-05-21", net: 105000, paid_amount: 105000, paid_status: "paid", reconciled_txn_id: "txn-21may" }),
  pay({ id: "sal-may", period: "2026-05", pay_date: "2026-06-20", net: 105000, paid_amount: 105000, paid_status: "paid", reconciled_txn_id: null }),
  pay({ id: "sal-sep", period: "2026-09", pay_date: null, net: 94080, paid_amount: 0, paid_status: "unpaid", reconciled_txn_id: null }),
];
vi.mock("@/lib/queries/payroll", () => ({
  useEmployees: () => ({ data: [{ id: "emp-sajan", name: "SAJAN SINGH NEGI", designation: "Engineer", joining_date: null }] }),
  useEmployeeSalaryHistory: () => ({ data: rows, isLoading: false }),
  useSalaryPayments: () => ({ data: [] }),
  useUnlinkedSalaryBankLines: () => ({ data: new Map() }),
  useSalaryBankLines: () => ({ data: new Map([["sal-apr", { txnId: "txn-21may", accountId: "acct-hdfc" }]]) }),
}));

import SalaryRegisterPage from "./page";

afterEach(() => { cleanup(); push.mockReset(); });

const rowOf = (month: string) => screen.getByText(month).closest("tr")!;

describe("R-1895 Salary register → bank line", () => {
  it("clicking the Apr 2026 Paid row opens that bank line", () => {
    render(<SalaryRegisterPage />);
    fireEvent.click(rowOf("Apr 2026"));
    expect(push).toHaveBeenCalledWith("/accounting/banking/acct-hdfc?txn=txn-21may");
  });

  it("Enter on the focused row opens it too", () => {
    render(<SalaryRegisterPage />);
    const tr = rowOf("Apr 2026");
    expect(tr.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(tr, { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/accounting/banking/acct-hdfc?txn=txn-21may");
    expect(within(tr).getByRole("link", { name: "Bank line" }).getAttribute("href")).toBe("/accounting/banking/acct-hdfc?txn=txn-21may");
  });

  it("Sep 2026 Not paid yet: not a link, no bank text", () => {
    render(<SalaryRegisterPage />);
    const tr = rowOf("Sep 2026");
    fireEvent.click(tr);
    expect(push).not.toHaveBeenCalled();
    expect(tr.getAttribute("tabindex")).toBeNull();
    expect(within(tr).queryByText("Bank line")).toBeNull();
    expect(within(tr).queryByText(/Not matched to bank/)).toBeNull();
  });

  it("Paid with no bank line: 'Not matched to bank' + Match into Banking", () => {
    render(<SalaryRegisterPage />);
    const tr = rowOf("May 2026");
    expect(within(tr).getByText(/Not matched to bank/)).toBeTruthy();
    expect(within(tr).getByRole("link", { name: "Match" }).getAttribute("href")).toBe("/accounting/banking");
    fireEvent.click(tr);
    expect(push).not.toHaveBeenCalled();
  });
});
