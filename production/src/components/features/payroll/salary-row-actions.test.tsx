// @vitest-environment jsdom
/* R-2771 — Hitesh (staging, 14 Nov): "I want to edit the salary of a specific month directly from
   here" (Salary Register). One shared ⋯ menu for a booked month — Payroll and both register views. */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const undoMutate = vi.fn();
let revState: Record<string, unknown> = { data: [], isSuccess: true };
const toastErr = vi.fn();
vi.mock("@/lib/errors/toast-error", () => ({ toastError: (...a: unknown[]) => toastErr(...a) }));
const confirmFn = vi.fn(async () => true);
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => confirmFn }));
vi.mock("@/lib/queries/payroll", () => ({
  useDeleteSalaryPayment: () => ({ mutate: undoMutate, isPending: false }),
  useSalaryRevisions: () => revState,
}));
vi.mock("@/app/(app)/accounting/payroll/screens", () => ({
  PaySalaryDialog: ({ editing, period, onClose }: { editing?: { id: string }; period: string; onClose: () => void }) => (
    <div role="dialog" aria-label="pay-dialog">editing {editing?.id ?? "none"} for {period}<button type="button" onClick={onClose}>Cancel</button></div>
  ),
}));
vi.mock("@/components/features/payroll/adjust-salary-lop-dialog", () => ({
  AdjustSalaryLopDialog: ({ salary }: { salary: { id: string } }) => <div role="dialog" aria-label="lop-dialog">lop {salary.id}</div>,
}));

import { SalaryRowActions } from "./salary-row-actions";

afterEach(() => { cleanup(); undoMutate.mockReset(); confirmFn.mockClear(); toastErr.mockReset(); revState = { data: [], isSuccess: true }; });

const emp = { id: "emp-1", name: "RAHUL KUMAR" } as never;
const sal = (o: Record<string, unknown> = {}) => ({
  id: "sal-oct", period: "2026-10", paid_amount: 0, paid_status: "unpaid", ...o,
}) as never;

const openMenu = () => {
  const trigger = screen.getByRole("button", { name: "Salary actions for Rahul Kumar, October 2026" });
  fireEvent.keyDown(trigger, { key: "Enter" });
};

describe("SalaryRowActions (R-2771)", () => {
  it("not yet linked to a bank line: Edit salary + Undo salary", () => {
    render(<SalaryRowActions employee={emp} p={sal()} canWrite />);
    openMenu();
    expect(screen.getByRole("menuitem", { name: /Edit salary$/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Undo salary/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /set LOP/ })).toBeNull();
  });

  it("Edit opens the Pay salary form for THAT month in edit mode — nothing is undone on open", () => {
    render(<SalaryRowActions employee={emp} p={sal()} canWrite />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Edit salary$/ }));
    expect(screen.getByRole("dialog", { name: "pay-dialog" }).textContent).toContain("editing sal-oct for 2026-10");
    expect(undoMutate).not.toHaveBeenCalled();
    expect(confirmFn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "pay-dialog" })).toBeNull();
    expect(undoMutate).not.toHaveBeenCalled();
  });

  it("Undo asks first, then undoes through delete_salary_payment", async () => {
    render(<SalaryRowActions employee={emp} p={sal()} canWrite />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Undo salary/ }));
    await vi.waitFor(() => expect(undoMutate).toHaveBeenCalledWith("sal-oct"));
    expect(confirmFn).toHaveBeenCalledWith(expect.objectContaining({ title: "Undo Rahul Kumar's salary for October 2026?", danger: true }));
  });

  it("linked to a bank line: no Edit / Undo — says why and links to that bank line", () => {
    render(<SalaryRowActions employee={emp} p={sal({ paid_amount: 27232, paid_status: "paid" })} canWrite bankLineHref="/accounting/banking/acct-1?txn=t-9" />);
    openMenu();
    expect(screen.queryByRole("menuitem", { name: /Edit salary$/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Undo salary/ })).toBeNull();
    expect(screen.getByText("Linked to a bank line — un-link it first to edit")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Open bank line/ }).getAttribute("href")).toBe("/accounting/banking/acct-1?txn=t-9");
  });

  it("part-paid: Edit salary — set LOP opens the R-2428 dialog", () => {
    render(<SalaryRowActions employee={emp} p={sal({ paid_amount: 10000, paid_status: "partial" })} canWrite />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /set LOP/ }));
    expect(screen.getByRole("dialog", { name: "lop-dialog" }).textContent).toBe("lop sal-oct");
  });

  it("viewer: no salary actions — and no empty separator under Payroll's own items", () => {
    render(<SalaryRowActions employee={emp} p={sal()} canWrite={false} onReconcile={() => {}} leading={<div role="menuitem">Download payslip</div>} />);
    openMenu();
    expect(screen.queryByRole("menuitem", { name: /Edit salary/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Undo salary/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Reconcile in Banking/ })).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("rev-r2771 #5 — Edit never silently does nothing: shows it is loading while the salary revisions are read", () => {
    revState = { data: undefined, isSuccess: false, isLoading: true };
    render(<SalaryRowActions employee={emp} p={sal()} canWrite />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Edit salary$/ }));
    expect(screen.queryByRole("dialog", { name: "pay-dialog" })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/Opening Rahul Kumar.s salary for October 2026/);
  });

  it("rev-r2771 #5 — revisions read failed: the error is shown and Edit can be pressed again", async () => {
    revState = { data: undefined, isSuccess: false, isError: true, error: new Error("network") };
    render(<SalaryRowActions employee={emp} p={sal()} canWrite />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Edit salary$/ }));
    await vi.waitFor(() => expect(toastErr).toHaveBeenCalledTimes(1));
    expect(toastErr.mock.calls[0][1]).toMatchObject({ fallback: expect.stringMatching(/Could not open Edit salary/) });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "pay-dialog" })).toBeNull();
  });

  it("rev-r2771 #3 — month after the exit month: Edit replaced by the reason, Undo stays", () => {
    render(<SalaryRowActions employee={{ id: "emp-1", name: "RAHUL KUMAR", exit_date: "2026-09-20" } as never} p={sal()} canWrite />);
    openMenu();
    expect(screen.queryByRole("menuitem", { name: /Edit salary$/ })).toBeNull();
    expect(screen.getByText(/October 2026 is after the last working day/)).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /^Undo salary$/ })).toBeTruthy();
  });

  it("advance record deleted since: Edit is replaced by the reason, Undo stays", () => {
    render(<SalaryRowActions employee={emp} p={sal({ advance_recovered: 5000, advance_loan_id: null })} canWrite />);
    openMenu();
    expect(screen.queryByRole("menuitem", { name: /Edit salary$/ })).toBeNull();
    expect(screen.getByText(/advance record was deleted/)).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /^Undo salary$/ })).toBeTruthy();
  });

  it("a click on the menu or its dialogs never reaches the register row (row opens employee / bank line)", () => {
    const rowClick = vi.fn();
    render(<table><tbody><tr onClick={rowClick}><td><SalaryRowActions employee={emp} p={sal()} canWrite /></td></tr></tbody></table>);
    const trigger = screen.getByRole("button", { name: /Salary actions/ });
    fireEvent.click(trigger);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Edit salary$/ }));
    fireEvent.click(screen.getByRole("dialog", { name: "pay-dialog" }));
    expect(rowClick).not.toHaveBeenCalled();
  });
});
