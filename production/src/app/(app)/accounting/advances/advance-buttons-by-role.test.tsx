// @vitest-environment jsdom
/**
 * R-857 — /accounting/advances opens for billing too (nav PURCHASES), but the database lets only
 * an owner, manager or accountant give, top up or settle an employee advance (R-717). Billing saw
 * all three buttons and got "Only an owner, manager or accountant…" on click. The buttons now
 * follow the same rule as the RPCs; Edit / Delete stay (their RPCs allow billing).
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { ADVANCE_MONEY_ROLES, canMoveAdvanceMoney } from "@/lib/accounting/advance-roles";
import { PAYROLL_ROLES } from "@/lib/nav";

const state = vi.hoisted(() => ({ role: "owner" as string | null }));

vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: state.role === null ? null : { role: state.role }, isLoading: false }),
}));
vi.mock("@/lib/queries/advances", () => {
  const m = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    useEmployeeAdvances: () => ({
      isLoading: false,
      data: [{
        id: "a1", employee_name: "Ravi", purpose: "Travel", status: "active",
        disbursed_amount: 5000, total_spent: 1000, remaining_balance: 4000,
        disbursed_date: "2026-10-01", payment_method: "cash", linked_expenses: [],
      }],
    }),
    useDisburseAdvance: m, useTopUpAdvance: m, useSettleAdvance: m, useUpdateAdvance: m, useDeleteAdvance: m,
    ADVANCE_PAYMENT_METHODS: { cash: "Cash" },
  };
});
vi.mock("@/lib/queries/payroll", () => ({ useEmployees: () => ({ data: [] }) }));
vi.mock("@/lib/queries/bank", () => ({ useBankAccounts: () => ({ data: [] }) }));
vi.mock("@/lib/queries/vendor-bills", () => ({ getBillAttachmentUrl: vi.fn() }));
vi.mock("@/components/features/accounting/add-expense-dialog", () => ({ AddExpenseDialog: () => null }));

import EmployeeAdvancesPage from "./page";

beforeEach(() => { state.role = "owner"; });
afterEach(cleanup);

const moneyButtons = () => ({
  give: screen.queryByRole("button", { name: /Give Advance to Employee/ }),
  topUp: screen.queryByRole("button", { name: "Top-up" }),
  settle: screen.queryByRole("button", { name: "Settle" }),
});

describe("R-857 advance money buttons follow the RPC role rule", () => {
  it.each(["owner", "manager", "accountant"])("%s sees Give, Top-up and Settle", (role) => {
    state.role = role;
    render(<EmployeeAdvancesPage />);
    const b = moneyButtons();
    expect(b.give).not.toBeNull();
    expect(b.topUp).not.toBeNull();
    expect(b.settle).not.toBeNull();
  });

  it("billing sees none of them, is told who can, and keeps Record expense / Edit / Delete", () => {
    state.role = "billing";
    render(<EmployeeAdvancesPage />);
    const b = moneyButtons();
    expect(b.give).toBeNull();
    expect(b.topUp).toBeNull();
    expect(b.settle).toBeNull();
    expect(screen.getByText(/Only an owner, manager or accountant can give, top up or settle an advance/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Record expense/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit advance for Ravi" })).toBeTruthy();
  });

  it("while the role is unknown the buttons stay hidden (fail closed)", () => {
    state.role = null;
    render(<EmployeeAdvancesPage />);
    expect(moneyButtons().give).toBeNull();
  });

  it("the rule is the payroll rule and matches what the database enforces", () => {
    expect([...ADVANCE_MONEY_ROLES].sort()).toEqual([...PAYROLL_ROLES].sort());
    expect(canMoveAdvanceMoney("billing")).toBe(false);
    expect(canMoveAdvanceMoney(undefined)).toBe(false);

    // The latest migration that (re)defines each RPC carries its role gate.
    const dir = join(process.cwd(), "supabase/migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const fn of ["give_employee_advance", "top_up_employee_advance", "settle_employee_advance"]) {
      const head = new RegExp(`create or replace function public\\.${fn}\\(`, "i");
      const latest = files.filter((f) => head.test(readFileSync(join(dir, f), "utf8"))).pop();
      expect(latest, fn).toBeTruthy();
      const sql = readFileSync(join(dir, latest!), "utf8");
      const body = sql.slice(sql.search(head));
      const end = body.indexOf("end $$");
      const gate = body.slice(0, end).match(/current_user_has_role\(([^)]*)\)/);
      expect(gate, fn).toBeTruthy();
      const roles = gate![1].split(",").map((s) => s.trim().replace(/'/g, "")).sort();
      expect(roles, fn).toEqual([...ADVANCE_MONEY_ROLES].sort());
    }
  });
});
