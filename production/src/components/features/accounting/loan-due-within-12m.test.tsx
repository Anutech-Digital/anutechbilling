// @vitest-environment jsdom
/* R-2674 — "Due back within 12 months?" on a loan: the answer goes to set_loan_due_within_12m. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mutate = vi.fn();
let pending = false;
vi.mock("@/lib/queries/loans-current-split", () => ({
  useSetLoanDueWithin12m: () => ({ mutate, isPending: pending }),
}));

import { LoanDueWithin12m } from "./loan-due-within-12m";

afterEach(cleanup);
beforeEach(() => { mutate.mockReset(); pending = false; });

describe("R-2674 LoanDueWithin12m", () => {
  it("a loan given with no answer yet shows Choose… and saves Yes", () => {
    render(<LoanDueWithin12m kind="loan_given" loanId="L1" name="Julie Rawat" value={null} canEdit />);
    const sel = screen.getByLabelText("Due back within 12 months? Julie Rawat") as HTMLSelectElement;
    expect(sel.value).toBe("");
    expect(screen.getByText("Choose…")).toBeTruthy();
    fireEvent.change(sel, { target: { value: "yes" } });
    expect(mutate).toHaveBeenCalledWith({ kind: "loan_given", loanId: "L1", dueWithin: true });
  });

  it("a staff loan shows its answer (default Yes) with no Choose… and saves No", () => {
    render(<LoanDueWithin12m kind="employee_loan" loanId="S1" name="Staff One" value canEdit />);
    const sel = screen.getByLabelText("Due back within 12 months? Staff One") as HTMLSelectElement;
    expect(sel.value).toBe("yes");
    expect(screen.queryByText("Choose…")).toBeNull();
    fireEvent.change(sel, { target: { value: "no" } });
    expect(mutate).toHaveBeenCalledWith({ kind: "employee_loan", loanId: "S1", dueWithin: false });
  });

  it("while saving the control is disabled (no double save)", () => {
    pending = true;
    render(<LoanDueWithin12m kind="loan_given" loanId="L1" name="Julie Rawat" value={false} canEdit />);
    expect((screen.getByLabelText("Due back within 12 months? Julie Rawat") as HTMLSelectElement).disabled).toBe(true);
  });

  it("a role that cannot change it (manager) reads the answer as text — no control", () => {
    render(<LoanDueWithin12m kind="employee_loan" loanId="S1" name="Staff One" value={false} canEdit={false} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByTestId("due-within-12m-S1").textContent).toContain("non-current (due after 12 months)");
  });
});
