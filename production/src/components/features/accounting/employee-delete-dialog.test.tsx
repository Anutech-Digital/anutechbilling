// @vitest-environment jsdom
/** R-2701 — Delete employee: salary booked → the refusal names the months and offers Start exit; none → delete. */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const mutate = vi.hoisted(() => vi.fn());
const refetch = vi.hoisted(() => vi.fn());
const history = vi.hoisted(() => ({ data: [] as { period: string }[] | undefined, isLoading: false, isError: false, refetch }));
vi.mock("@/lib/queries/payroll", () => ({
  useDeleteEmployee: () => ({ mutate, isPending: false }),
  useEmployeeSalaryHistory: () => history,
}));
const loans = vi.hoisted(() => ({ data: [] as { employee_name: string; disbursed_on: string; outstanding: number }[] | undefined, isLoading: false, isError: false, refetch: () => {} }));
vi.mock("@/lib/queries/employee-loans", () => ({ useEmployeeLoans: () => loans }));

import { EmployeeDeleteDialog } from "./employee-delete-dialog";

const emp = { id: "e-1", name: "prashant kumar", exit_date: null };

beforeEach(() => {
  mutate.mockClear(); refetch.mockClear();
  history.data = []; history.isLoading = false; history.isError = false;
  loans.data = []; loans.isLoading = false; loans.isError = false;
});
afterEach(cleanup);

describe("R-2701 EmployeeDeleteDialog", () => {
  it("Hitesh's case: 2 booked months → names Sep 2026 and Oct 2026, no Delete button, Start exit + See salary offered", () => {
    history.data = [{ period: "2026-09" }, { period: "2026-10" }];
    const onStartExit = vi.fn();
    const onShowSalary = vi.fn();
    render(<EmployeeDeleteDialog employee={emp} canStartExit onStartExit={onStartExit} onShowSalary={onShowSalary} onClose={() => {}} />);
    expect(screen.getByText(/Salary is booked for 2 months \(Sep 2026 and Oct 2026\)/)).toBeTruthy();
    expect(screen.getByText("Prashant Kumar can't be deleted")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete employee" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start exit" }));
    expect(onStartExit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "See salary months" }));
    expect(onShowSalary).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("not the owner → no Start exit button, says the owner does it", () => {
    history.data = [{ period: "2026-09" }];
    render(<EmployeeDeleteDialog employee={emp} canStartExit={false} onStartExit={() => {}} onShowSalary={() => {}} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Start exit" })).toBeNull();
    expect(screen.getByText(/Only the owner can start an exit/)).toBeTruthy();
  });

  it("already leaving → no second Start exit; says the exit is set", () => {
    history.data = [{ period: "2026-09" }];
    render(<EmployeeDeleteDialog employee={{ ...emp, exit_date: "2026-11-30" }} canStartExit onStartExit={() => {}} onShowSalary={() => {}} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Start exit" })).toBeNull();
    expect(screen.getByText(/last working day is already set/)).toBeTruthy();
  });

  it("no salary booked → plain delete confirm; Delete employee calls the delete once", () => {
    const onClose = vi.fn();
    render(<EmployeeDeleteDialog employee={emp} canStartExit onStartExit={() => {}} onShowSalary={() => {}} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete employee" }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toBe("e-1");
  });

  it("still loading the salary check → no Delete button yet", () => {
    history.data = undefined; history.isLoading = true;
    render(<EmployeeDeleteDialog employee={emp} canStartExit onStartExit={() => {}} onShowSalary={() => {}} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Delete employee" })).toBeNull();
    expect(screen.getByText(/Checking salary records/)).toBeTruthy();
  });

  it("salary check failed → no Delete button (never delete blind); Try again re-reads", () => {
    history.data = undefined; history.isError = true;
    render(<EmployeeDeleteDialog employee={emp} canStartExit onStartExit={() => {}} onShowSalary={() => {}} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Delete employee" })).toBeNull();
    expect(screen.getByText(/Could not check salary records/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("no salary but a salary advance still due → the confirm names what they owe (kept on the Loans page)", () => {
    loans.data = [
      { employee_name: "Prashant Kumar", disbursed_on: "2026-10-01", outstanding: 10000 },
      { employee_name: "Someone Else", disbursed_on: "2026-10-01", outstanding: 999 },
    ];
    render(<EmployeeDeleteDialog employee={emp} canStartExit onStartExit={() => {}} onShowSalary={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/They still owe ₹10,000 on loans or salary advances/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete employee" })).toBeTruthy();
  });
});
