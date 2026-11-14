// @vitest-environment jsdom
/* R-2771 — Hitesh (staging, 14 Nov), on the Salary Register opened from the employee profile:
   "I want to edit the salary of a specific month directly from here". Both register views get the
   shared salary menu (SalaryRowActions — its own tests cover the items); viewers get no column. */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

let role = "owner";
let search = "employee=emp-asha";
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role } }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("../payroll/screens", () => ({ HrPageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/lib/queries/payroll-policy", () => ({ usePayrollPolicy: () => ({ data: undefined }) }));
vi.mock("@/components/features/payroll/salary-row-actions", () => ({
  SalaryRowActions: ({ employee, p, bankLineHref }: { employee: { name: string }; p: { period: string }; bankLineHref?: string | null }) => (
    <button type="button" data-href={bankLineHref ?? ""}>{`menu ${employee.name} ${p.period}`}</button>
  ),
}));

const pay = (o: Record<string, unknown>) => ({
  employee_id: "emp-asha", gross: 30000, incentive: 0, lop_amount: 0, tds: 0, pf: 0, esi: 0, other_deduction: 0,
  expense_id: null, arrears: 0, ...o,
});
const rows = [
  pay({ id: "sal-aug", period: "2026-08", pay_date: "2026-08-31", net: 30000, paid_amount: 30000, paid_status: "paid", reconciled_txn_id: "txn-aug" }),
  pay({ id: "sal-sep", period: "2026-09", pay_date: "2026-09-30", net: 30000, paid_amount: 0, paid_status: "unpaid", reconciled_txn_id: null }),
];
vi.mock("@/lib/queries/payroll", () => ({
  useEmployees: () => ({ data: [{ id: "emp-asha", name: "ASHA RANI", designation: "Accountant", joining_date: null }] }),
  useEmployeeSalaryHistory: () => ({ data: rows, isLoading: false }),
  useSalaryPayments: () => ({ data: rows, isLoading: false, isSuccess: true }),
  useUnlinkedSalaryBankLines: () => ({ data: new Map() }),
  useSalaryBankLines: () => ({ data: new Map([["sal-aug", { txnId: "txn-aug", accountId: "acct-hdfc" }]]) }),
  useSalaryRevisions: () => ({ data: [], isSuccess: true }),
}));

import SalaryRegisterPage from "./page";

afterEach(() => { cleanup(); push.mockReset(); role = "owner"; search = "employee=emp-asha"; });

const rowOf = (text: string) => screen.getByText(text).closest("tr")!;

describe("R-2771 Salary Register — change a month from its row", () => {
  it("employee FY view: every booked month has the salary menu; a linked month gets its bank line", () => {
    render(<SalaryRegisterPage />);
    expect(within(rowOf("Sep 2026")).getByRole("button", { name: "menu ASHA RANI 2026-09" }).getAttribute("data-href")).toBe("");
    expect(within(rowOf("Aug 2026")).getByRole("button", { name: "menu ASHA RANI 2026-08" }).getAttribute("data-href"))
      .toBe("/accounting/banking/acct-hdfc?txn=txn-aug");
  });

  it("the header, rows and totals keep one cell per column", () => {
    render(<SalaryRegisterPage />);
    const head = screen.getAllByRole("columnheader");
    expect(head.at(-1)!.textContent).toBe("Change salary");
    const total = rowOf("2 months");
    expect(total.querySelectorAll("td").length - 1 /* label spans 2 */ + 2).toBe(head.length);
    expect(rowOf("Sep 2026").querySelectorAll("td").length).toBe(head.length);
  });

  it("month view: each employee row has the menu for that month", () => {
    search = "";
    render(<SalaryRegisterPage />);
    const menus = screen.getAllByRole("button", { name: /^menu ASHA RANI/ });
    expect(menus).toHaveLength(2);
    for (const m of menus) expect(m.closest("tr")!.getAttribute("role")).toBe("button");
    expect(screen.getAllByRole("columnheader").some((h) => h.textContent === "Change salary")).toBe(true);
  });

  it("viewer: no menu, no extra column", () => {
    role = "viewer";
    render(<SalaryRegisterPage />);
    expect(screen.queryByRole("button", { name: /^menu / })).toBeNull();
    expect(screen.getAllByRole("columnheader").some((h) => h.textContent === "Change salary")).toBe(false);
  });
});
