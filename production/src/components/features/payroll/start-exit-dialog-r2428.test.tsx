// @vitest-environment jsdom
/**
 * R-2428 — after a full & final is booked from a bank line, "Start exit" opens with the last
 * working day = the payment date (owner's case: Keshav Malik, F&F paid 16 Apr 2026) — one click.
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
  istToday: () => "2026-11-03",
}));

import { StartExitDialog } from "./start-exit-dialog";

const keshav = { id: "e-k", name: "Keshav Malik", joining_date: "2026-04-01" };

beforeEach(() => mutate.mockClear());
afterEach(cleanup);

describe("R-2428 StartExitDialog from a full & final", () => {
  it("last day = the F&F payment date, no resignation date, says why — one click starts the exit", () => {
    render(<StartExitDialog employee={keshav} initialLastDay="2026-04-16" reasonText="Full & final ₹19,056 paid on 16 Apr 2026." onClose={() => {}} />);
    expect((screen.getByLabelText(/^Last working day/) as HTMLInputElement).value).toBe("2026-04-16");
    expect((screen.getByLabelText("Resignation date") as HTMLInputElement).value).toBe("");
    expect(screen.getByText(/Full & final ₹19,056 paid on 16 Apr 2026/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start exit" }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({
      employeeId: "e-k", lastDay: "2026-04-16", reason: "resigned", resignationDate: null, note: null,
    });
  });

  it("changing notice does not move a preset last day", () => {
    render(<StartExitDialog employee={keshav} initialLastDay="2026-04-16" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Notice period (days)"), { target: { value: "15" } });
    expect((screen.getByLabelText(/^Last working day/) as HTMLInputElement).value).toBe("2026-04-16");
  });
});
