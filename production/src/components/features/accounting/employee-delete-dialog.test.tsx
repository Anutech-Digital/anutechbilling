// @vitest-environment jsdom
/** R-2698 + R-2701 — the one Delete employee dialog: booked records → named, Start exit / Edit + See salary months; none → delete. */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

type Blockers = { salaryMonths: string[]; projectLabour: number; expenseClaims: number };
const mutate = vi.hoisted(() => vi.fn());
const refetch = vi.hoisted(() => vi.fn());
const blockersQ = vi.hoisted(() => ({ data: undefined as Blockers | undefined, isLoading: false, isError: false, refetch }));
vi.mock("@/lib/queries/payroll", () => ({
  useDeleteEmployee: () => ({ mutate, isPending: false }),
  useEmployeeDeleteBlockers: () => blockersQ,
}));
const loans = vi.hoisted(() => ({ data: [] as { employee_name: string; disbursed_on: string; outstanding: number; status: string }[] | undefined, isLoading: false, isError: false, refetch: () => {} }));
vi.mock("@/lib/queries/employee-loans", () => ({ useEmployeeLoans: () => loans }));

import { EmployeeDeleteDialog } from "./employee-delete-dialog";

const emp = { id: "e-1", name: "prashant kumar", exit_date: null };
const none: Blockers = { salaryMonths: [], projectLabour: 0, expenseClaims: 0 };
const props = { isOwner: true, onStartExit: () => {}, onEdit: () => {}, onShowSalary: () => {}, onClose: () => {} };

beforeEach(() => {
  mutate.mockClear(); refetch.mockClear();
  blockersQ.data = none; blockersQ.isLoading = false; blockersQ.isError = false;
  loans.data = []; loans.isLoading = false; loans.isError = false;
});
afterEach(cleanup);

describe("EmployeeDeleteDialog (R-2698 blockers + R-2701 salary months)", () => {
  it("Hitesh's case: 2 booked months → names Sep 2026, Oct 2026; no Delete; Start exit + See salary months", () => {
    blockersQ.data = { ...none, salaryMonths: ["2026-09", "2026-10"] };
    const onStartExit = vi.fn();
    const onShowSalary = vi.fn();
    render(<EmployeeDeleteDialog employee={emp} {...props} onStartExit={onStartExit} onShowSalary={onShowSalary} />);
    expect(screen.getByText("Prashant Kumar can't be deleted")).toBeTruthy();
    expect(screen.getByText(/salary booked for Sep 2026, Oct 2026/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete employee" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start exit" }));
    expect(onStartExit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "See salary months" }));
    expect(onShowSalary).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("only project labour / expense claims → no See salary months; not the owner → Edit employee instead of Start exit", () => {
    blockersQ.data = { ...none, projectLabour: 2, expenseClaims: 1 };
    const onEdit = vi.fn();
    render(<EmployeeDeleteDialog employee={emp} {...props} isOwner={false} onEdit={onEdit} />);
    expect(screen.getByText(/2 project labour entries, 1 expense claim/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "See salary months" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start exit" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit employee" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("already leaving → no second Start exit; says the last day is set", () => {
    blockersQ.data = { ...none, salaryMonths: ["2026-09"] };
    render(<EmployeeDeleteDialog employee={{ ...emp, exit_date: "2026-11-30" }} {...props} />);
    expect(screen.queryByRole("button", { name: "Start exit" })).toBeNull();
    expect(screen.getByText(/last working day is already set/)).toBeTruthy();
  });

  it("nothing booked → plain delete confirm; Delete employee calls the delete once with id + name", () => {
    render(<EmployeeDeleteDialog employee={emp} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete employee" }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({ id: "e-1", name: "prashant kumar", canExit: true });
  });

  it("still checking → no Delete button yet", () => {
    blockersQ.data = undefined; blockersQ.isLoading = true;
    render(<EmployeeDeleteDialog employee={emp} {...props} />);
    expect(screen.queryByRole("button", { name: "Delete employee" })).toBeNull();
    expect(screen.getByText(/Checking what is booked/)).toBeTruthy();
  });

  it("check failed → no Delete button (never delete blind); Try again re-reads", () => {
    blockersQ.data = undefined; blockersQ.isError = true;
    render(<EmployeeDeleteDialog employee={emp} {...props} />);
    expect(screen.queryByRole("button", { name: "Delete employee" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("loans read failed → the delete is still offered (loans are only a note)", () => {
    loans.data = undefined; loans.isError = true;
    render(<EmployeeDeleteDialog employee={emp} {...props} />);
    expect(screen.getByRole("button", { name: "Delete employee" })).toBeTruthy();
  });

  it("a re-read still running → no Delete from the cached answer yet", () => {
    (blockersQ as { isFetching?: boolean }).isFetching = true;
    render(<EmployeeDeleteDialog employee={emp} {...props} />);
    expect(screen.queryByRole("button", { name: "Delete employee" })).toBeNull();
    (blockersQ as { isFetching?: boolean }).isFetching = false;
  });

  it("nothing booked but a salary advance still due → the confirm names what they owe", () => {
    loans.data = [
      { employee_name: "Prashant Kumar", disbursed_on: "2026-10-01", outstanding: 10000, status: "active" },
      { employee_name: "Prashant Kumar", disbursed_on: "2026-01-01", outstanding: 4000, status: "closed" },
      { employee_name: "Someone Else", disbursed_on: "2026-10-01", outstanding: 999, status: "active" },
    ];
    render(<EmployeeDeleteDialog employee={emp} {...props} />);
    expect(screen.getByText(/They still owe ₹10,000 on loans or salary advances/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete employee" })).toBeTruthy();
  });
});
