// @vitest-environment jsdom
/** R-2428 — Edit salary (LOP) on a part-paid record: starts at net = paid, needs a reason, one RPC call. */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const mutate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/queries/payroll", () => ({ useAdjustSalaryLop: () => ({ mutate, isPending: false }) }));

import { AdjustSalaryLopDialog } from "./adjust-salary-lop-dialog";
import type { SalaryPayment } from "@/lib/queries/payroll";

const apr = {
  id: "s-1", period: "2026-04", gross: 24358, lop_days: 0, lop_amount: 0, incentive: 0, advance_recovered: 0,
  tds: 0, pf: 0, esi: 0, other_deduction: 0, net: 24358, paid_amount: 19056, paid_status: "partial",
} as unknown as SalaryPayment;

beforeEach(() => mutate.mockClear());
afterEach(cleanup);

describe("R-2428 AdjustSalaryLopDialog", () => {
  it("owner's case: LOP ₹5,302 prefilled → net ₹19,056 = paid; Save needs a reason", () => {
    render(<AdjustSalaryLopDialog name="Keshav Malik" salary={apr} onClose={() => {}} />);
    expect((screen.getByLabelText(/^Loss of pay/) as HTMLInputElement).value).toBe("5302");
    expect(screen.getByText(/equals what was paid/)).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save salary" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/^LOP days/), { target: { value: "14" } });
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: "Left 16 Apr — full & final paid" } });
    fireEvent.click(save);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({ salaryId: "s-1", lopDays: 14, lopAmount: 5302, reason: "Left 16 Apr — full & final paid" });
  });

  it("LOP that takes the net below what was paid is refused before the server", () => {
    render(<AdjustSalaryLopDialog name="Keshav Malik" salary={apr} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/^Loss of pay/), { target: { value: "8000" } });
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: "too much" } });
    expect(screen.getByText(/already paid ₹19056/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save salary" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
