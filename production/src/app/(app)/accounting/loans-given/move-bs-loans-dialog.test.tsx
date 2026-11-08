// @vitest-environment jsdom
/* R-2604 — Check first lists each person once (net), the employee row is ticked and can be unticked,
   skipped groups show why, and Move sends the confirmed employee links + Check first's total. */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mutate = vi.fn();
const preview = {
  groups: [
    { key: "aakash deep", name: "Aakash Deep", given: 150000, returned: 30000, net: 120000, rows: [{}, {}, {}], lines: 3, first_date: "2026-06-05", target: "loan_given", skip_reason: null, employee: null, merge_loan: null },
    { key: "pardeep", name: "Pardeep", given: 800000, returned: 0, net: 800000, rows: [{}], lines: 1, first_date: "2026-05-10", target: "employee", skip_reason: null, employee: { id: "emp-1", name: "Pardeep Sharma" }, merge_loan: null },
    { key: "vinod", name: "VINOD", given: 40000, returned: 0, net: 40000, rows: [{}], lines: 1, first_date: "2026-08-02", target: "loan_given", skip_reason: null, employee: null, merge_loan: { id: "l-9", principal: 10000 } },
    { key: "rajeev", name: "Rajeev", given: 5000, returned: 5000, net: 0, rows: [{}, {}], lines: 0, first_date: "2026-01-01", target: "skip", skip_reason: "Returned is as much as given or more", employee: null, merge_loan: null },
  ],
  movable_net: 960000, total_before: 1500000, total_after: 1500000,
};

vi.mock("@/lib/queries/loans-given", async (orig) => {
  const real = await orig<typeof import("@/lib/queries/loans-given")>();
  return {
    ...real,
    useBsLoanMovePreview: () => ({ data: preview, isLoading: false, isError: false }),
    useApplyBsLoanMove: () => ({ mutate, isPending: false }),
  };
});

import { MoveBsLoansDialog } from "./move-bs-loans-dialog";
import { employeeLinks, type BsLoanMoveGroup } from "@/lib/queries/loans-given";

afterEach(() => { cleanup(); mutate.mockReset(); });

describe("MoveBsLoansDialog (R-2604)", () => {
  it("shows each person once with where it goes and the unchanged total", () => {
    render(<MoveBsLoansDialog open onOpenChange={vi.fn()} />);
    expect(screen.getAllByTestId("r2604-move-row")).toHaveLength(3);
    expect(screen.getByText("Employee loan — Pardeep Sharma")).toBeTruthy();
    expect(screen.getByText(/Added to the open loan/)).toBeTruthy();
    expect(screen.getByText(/Stay on the Balance Sheet/)).toBeTruthy();
    expect(screen.getByTestId("r2604-move-totals").textContent).toMatch(/unchanged/);
  });

  it("Move sends the ticked employee and Check first's total; unticked → Loans given", () => {
    render(<MoveBsLoansDialog open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Move / }));
    expect(mutate.mock.calls[0][0]).toEqual({ links: { pardeep: "emp-1" }, expectedNet: 960000 });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.queryByText("Employee loan — Pardeep Sharma")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Move / }));
    expect(mutate.mock.calls[1][0]).toEqual({ links: {}, expectedNet: 960000 });
  });
});

describe("employeeLinks", () => {
  it("only ticked employee groups", () => {
    const gs = preview.groups as unknown as BsLoanMoveGroup[];
    expect(employeeLinks(gs, new Set())).toEqual({ pardeep: "emp-1" });
    expect(employeeLinks(gs, new Set(["pardeep"]))).toEqual({});
  });
});
