// @vitest-environment jsdom
/**
 * R-1436 — the owner links an employee profile to a teammate's login (and unlinks it) on the
 * Employees page, so a sales / support login can check in at /attendance/me without a DB edit.
 * Only the owner sees the control: the DB guard (R-712) refuses anyone else.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";

import type { TenantLogin } from "@/lib/attendance/login-link";

const state = vi.hoisted(() => ({
  role: "owner" as string | null,
  loginsEnabled: null as boolean | null,
  logins: [] as TenantLogin[],
  employees: [] as { id: string; name: string; email: string | null; is_active: boolean }[],
}));
const mutate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: { role: state.role, tenantId: "t1" }, isLoading: false }),
}));
vi.mock("@/lib/queries/payroll", () => ({
  useEmployees: () => ({ data: state.employees, isLoading: false, error: null }),
}));
vi.mock("@/lib/queries/employee-login-link", () => ({
  useTenantLogins: (enabled: boolean) => {
    state.loginsEnabled = enabled;
    return { data: enabled ? state.logins : undefined, isLoading: false, error: null };
  },
  useLinkLogin: () => ({ mutate, isPending: false }),
}));

import { EmployeeLoginsPanel } from "./employee-logins-panel";

beforeEach(() => {
  state.role = "owner";
  state.loginsEnabled = null;
  state.employees = [
    { id: "e-pawan", name: "Pawan Sales", email: "pawan.sales@acme.in", is_active: true },
    { id: "e-asha", name: "Asha Verma", email: null, is_active: true },
    { id: "e-old", name: "Old Hand", email: null, is_active: false },
  ];
  state.logins = [
    { id: "u-owner", full_name: "Owner", email: "o@acme.in", role: "owner", employee_id: null, is_active: true },
    { id: "u-sales", full_name: "Pawan", email: "pawan.sales@acme.in", role: "sales", employee_id: null, is_active: true },
    { id: "u-sup", full_name: "Asha", email: "asha@acme.in", role: "support", employee_id: "e-asha", is_active: true },
  ];
  mutate.mockClear();
});
afterEach(cleanup);

describe("R-1436 EmployeeLoginsPanel", () => {
  it("owner sees a Login picker per active employee, and the linked one is shown", () => {
    render(<EmployeeLoginsPanel />);
    expect(state.loginsEnabled).toBe(true);
    const pawan = screen.getByRole("combobox", { name: "Login for Pawan Sales" }) as HTMLSelectElement;
    expect(pawan.value).toBe("");
    const asha = screen.getByRole("combobox", { name: "Login for Asha Verma" }) as HTMLSelectElement;
    expect(asha.value).toBe("u-sup");
    // inactive employees don't check in — no row for them
    expect(screen.queryByRole("combobox", { name: "Login for Old Hand" })).toBeNull();
    // a login linked to someone else is not offered to Pawan
    expect(within(pawan).queryByRole("option", { name: /Asha/ })).toBeNull();
  });

  it("owner links a free login to an employee", () => {
    render(<EmployeeLoginsPanel />);
    fireEvent.change(screen.getByRole("combobox", { name: "Login for Pawan Sales" }), { target: { value: "u-sales" } });
    expect(mutate).toHaveBeenCalledWith({ employeeName: "Pawan Sales", writes: [{ userId: "u-sales", employeeId: "e-pawan" }] });
  });

  it("owner unlinks a linked login", () => {
    render(<EmployeeLoginsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Unlink Asha Verma's login" }));
    expect(mutate).toHaveBeenCalledWith({ employeeName: "Asha Verma", writes: [{ userId: "u-sup", employeeId: null }] });
    // no Unlink for an employee with nothing linked
    expect(screen.queryByRole("button", { name: "Unlink Pawan Sales's login" })).toBeNull();
  });

  it.each(["manager", "accountant", "sales", "support", "delivery", "billing", null])(
    "%s sees no link control and no list of logins is fetched",
    (role) => {
      state.role = role;
      render(<EmployeeLoginsPanel />);
      expect(state.loginsEnabled).toBe(false);
      expect(screen.queryByRole("combobox")).toBeNull();
      expect(screen.queryByText(/Logins for attendance/)).toBeNull();
    },
  );

  it("no free login: says why and points to Team to invite one (§24)", () => {
    state.logins = state.logins.filter((l) => l.id !== "u-sales" && l.id !== "u-owner");
    render(<EmployeeLoginsPanel />);
    expect(screen.getAllByRole("link", { name: /Invite on Team/ })[0].getAttribute("href")).toBe("/team");
  });
});
