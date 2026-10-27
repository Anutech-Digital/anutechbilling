// @vitest-environment jsdom
/**
 * R-1896 — "Start exit" on an employee. Owner's example: Ravi resigns on 1 Oct with 30 days'
 * notice → last working day defaults to 30 Oct; if the owner moves it to 20 Oct the dialog says
 * 10 days short. The primary button calls start_employee_exit once with the last day + reason.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const mutate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/queries/payroll", () => ({
  useStartEmployeeExit: () => ({ mutate, isPending: false }),
}));
vi.mock("@/lib/dates/ist", async (orig) => ({
  ...(await orig<typeof import("@/lib/dates/ist")>()),
  istToday: () => "2026-10-01",
}));

import { StartExitDialog } from "./start-exit-dialog";

const ravi = { id: "e-ravi", name: "Ravi Kumar", joining_date: "2020-04-01" };

beforeEach(() => mutate.mockClear());
afterEach(cleanup);

describe("R-1896 StartExitDialog", () => {
  it("defaults: resignation today, 30 days notice → last day 30 Oct, reason Resigned", () => {
    render(<StartExitDialog employee={ravi} onClose={() => {}} />);
    expect((screen.getByLabelText("Resignation date") as HTMLInputElement).value).toBe("2026-10-01");
    expect((screen.getByLabelText("Notice period (days)") as HTMLInputElement).value).toBe("30");
    expect((screen.getByLabelText(/^Last working day/) as HTMLInputElement).value).toBe("2026-10-30");
    expect((screen.getByLabelText(/^Reason/) as HTMLSelectElement).value).toBe("resigned");
    expect(screen.getByText(/Full notice served/)).toBeTruthy();
    expect(screen.getByText(/If they have a login, it stops working after/)).toBeTruthy();
  });

  it("earlier last day → shows the notice shortfall (owner example: 10 days short)", () => {
    render(<StartExitDialog employee={ravi} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/^Last working day/), { target: { value: "2026-10-20" } });
    expect(screen.getByText(/10 days short of the 30-day notice/)).toBeTruthy();
  });

  it("Start exit calls the RPC hook once with last day, reason, resignation date", () => {
    const onClose = vi.fn();
    render(<StartExitDialog employee={ravi} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText(/^Last working day/), { target: { value: "2026-10-20" } });
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: "terminated" } });
    fireEvent.click(screen.getByRole("button", { name: "Start exit" }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({
      employeeId: "e-ravi", lastDay: "2026-10-20", reason: "terminated", resignationDate: "2026-10-01", note: null,
    });
  });

  it("a last day before joining is refused before calling the server", () => {
    render(<StartExitDialog employee={ravi} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/^Last working day/), { target: { value: "2019-01-01" } });
    expect(screen.getByText(/before they joined/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Start exit" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
