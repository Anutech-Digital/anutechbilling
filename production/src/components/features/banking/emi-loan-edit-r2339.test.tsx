// @vitest-environment jsdom
/* R-2339 — Business Loans: Edit / Delete on a loan set up from an EMI line.
   Owner example: R-2323's bike loan (₹2,50,000, 11%, 14 EMIs of ₹19,054 from 5 Oct 2026); after
   EMI 1 → ₹2,33,238 still owed. The rate was typed wrong — the loan letter says 10.5%. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const role = { current: "owner" as string };
const confirmFn = vi.fn(async () => true);
const deleteMutate = vi.fn();
const editMutateAsync = vi.fn(async (_p: unknown) => ({ from_seq: 2, emis_left: 13 }));

vi.mock("@/components/features/accounting/emi-loan-dialogs", () => ({ EmiScheduleDialog: () => <div>schedule dialog</div> }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: role.current } }) }));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => confirmFn }));
vi.mock("./emi-loan-edit-query", () => ({
  useDeleteEmiLoan: () => ({ mutate: deleteMutate }),
  useEditEmiLoan: () => ({ mutateAsync: editMutateAsync, isPending: false }),
}));
vi.mock("@/lib/queries/emi", () => ({
  useEmiSchedule: () => ({
    isLoading: false,
    data: {
      payments: [],
      rows: Array.from({ length: 14 }, (_, i) => ({
        seq: i + 1, due_on: `${i < 3 ? 2026 : 2027}-${String(((9 + i) % 12) + 1).padStart(2, "0")}-05`,
        emi_payment_id: i === 0 ? "pay-1" : null,
      })),
    },
  }),
}));

import { EmiLoansTaken } from "./emi-loans-taken";
import type { EmiPurchase } from "@/lib/queries/emi";

const bike = (over: Partial<EmiPurchase> = {}) => ({
  id: "p1", name: "Loan — HDFC Bank", lender: "HDFC Bank", lender_ref: "BIKE", kind: "loan", status: "active",
  financed: 250000, emi_amount: 19054, emi_count: 14, interest_rate: 11, first_emi_on: "2026-10-05",
  outstanding: 233238, emisPaid: 1, principalPaid: 16762, ...over,
}) as unknown as EmiPurchase;

beforeEach(() => { role.current = "owner"; confirmFn.mockClear(); deleteMutate.mockClear(); editMutateAsync.mockClear(); });
afterEach(cleanup);

describe("R-2339 — Edit / Delete on the Business Loans row", () => {
  it("EMI 1 paid → Edit, no Delete", () => {
    render(<EmiLoansTaken loans={[bike()]} />);
    const row = screen.getByTestId("emi-loan-row");
    expect(within(row).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("no EMI paid → Delete asks first, then deletes that loan", async () => {
    render(<EmiLoansTaken loans={[bike({ emisPaid: 0, outstanding: 250000, principalPaid: 0 })]} />);
    fireEvent.click(within(screen.getByTestId("emi-loan-row")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteMutate).toHaveBeenCalledWith("p1"));
    expect(confirmFn).toHaveBeenCalledWith(expect.objectContaining({ title: "Delete the HDFC Bank loan (₹2,50,000)?", danger: true }));
  });

  it("confirm cancelled → nothing deleted", async () => {
    confirmFn.mockResolvedValueOnce(false);
    render(<EmiLoansTaken loans={[bike({ emisPaid: 0 })]} />);
    fireEvent.click(within(screen.getByTestId("emi-loan-row")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    expect(deleteMutate).not.toHaveBeenCalled();
  });

  it("a sales login sees neither; a cleared loan has no Edit", () => {
    role.current = "sales";
    render(<EmiLoansTaken loans={[bike({ emisPaid: 0 })]} />);
    expect(screen.queryAllByRole("button", { name: /^(Edit|Delete)$/ })).toHaveLength(0);
    cleanup();
    role.current = "owner";
    render(<EmiLoansTaken loans={[bike({ status: "closed", outstanding: 0, emisPaid: 14 })]} />);
    expect(screen.queryAllByRole("button", { name: "Edit" })).toHaveLength(0);
  });

  it("Edit: rate 11% → 10.5% previews EMI 2 at ₹2,041 interest and saves only the unpaid EMIs 2–14", async () => {
    render(<EmiLoansTaken loans={[bike()]} />);
    fireEvent.click(within(screen.getByTestId("emi-loan-row")).getByRole("button", { name: "Edit" }));
    const months = await screen.findByLabelText("EMIs left (not paid yet)") as HTMLInputElement;
    expect(months.value).toBe("13");
    fireEvent.change(screen.getByLabelText("Interest rate (% a year)"), { target: { value: "10.5" } });
    const preview = screen.getByTestId("loan-edit-preview");
    expect(preview.textContent).toContain("EMI 2 — interest (expense)₹2,041");
    expect(preview.textContent).toContain("13 EMIs of ₹19,054 (last one ₹19,129)");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(editMutateAsync).toHaveBeenCalledTimes(1));
    const payload = editMutateAsync.mock.calls[0][0] as { purchase_id: string; interest_rate: number; schedule: { seq: number }[] };
    expect(payload.purchase_id).toBe("p1");
    expect(payload.interest_rate).toBe(10.5);
    expect(payload.schedule.map((r) => r.seq)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(payload.schedule[0]).toEqual({ seq: 2, due_on: "2026-11-05", emi: 19054, principal: 17013, interest: 2041, balance_after: 216225 });
  });

  it("Edit: an EMI that cannot pay the interest blocks Save with the reason", async () => {
    render(<EmiLoansTaken loans={[bike()]} />);
    fireEvent.click(within(screen.getByTestId("emi-loan-row")).getByRole("button", { name: "Edit" }));
    fireEvent.change(await screen.findByLabelText("EMI (₹)"), { target: { value: "1000" } });
    expect(screen.getByText(/does not cover the month's interest/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
