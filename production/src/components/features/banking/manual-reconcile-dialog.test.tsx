// @vitest-environment jsdom
/* R-2361 — Banking → a line → Reconcile → "Mark reconciled manually" asks first.
   Staging, 2 Nov 2026: one click closed a ₹12,00,000 line with no confirm and no note. The confirm
   shows the line, needs a reason (5+ characters), can pair the opposite line as its reversal, and
   Cancel changes nothing. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { LineLike } from "@/lib/banking/manual-reconcile";

const state = vi.hoisted(() => ({ save: vi.fn(), candidates: [] as unknown[] }));
vi.mock("@/lib/banking/manual-reconcile", async (orig) => ({
  ...(await orig<typeof import("@/lib/banking/manual-reconcile")>()),
  useReconcileManually: () => ({ mutateAsync: state.save, isPending: false }),
  useReversalCandidates: () => ({ data: state.candidates, isLoading: false }),
}));

import { ManualReconcileDialog } from "./manual-reconcile-dialog";

const out: LineLike = {
  id: "t-out", bank_account_id: "acc-1", txn_date: "2026-10-10", description: "RTGS OUT FAILED",
  debit: 1200000, credit: 0, matched_to_type: null,
};
const back: LineLike = {
  id: "t-back", bank_account_id: "acc-1", txn_date: "2026-10-12", description: "RTGS RETURN",
  debit: 0, credit: 1200000, matched_to_type: null,
};

const saveBtn = () => screen.getByRole("button", { name: /^(Mark reconciled|Reconcile both lines)$/ }) as HTMLButtonElement;
const reason = () => screen.getByLabelText("Reason (required)") as HTMLTextAreaElement;

describe("R-2361 ManualReconcileDialog", () => {
  beforeEach(() => { state.save.mockReset(); state.save.mockResolvedValue({}); state.candidates = []; });
  afterEach(() => cleanup());

  it("shows the line's date, amount and description", () => {
    render(<ManualReconcileDialog txn={out} open onCancel={() => {}} onDone={() => {}} />);
    expect(screen.getByText(/10 Oct 2026 · Money out ₹12,00,000 · RTGS OUT FAILED/)).toBeTruthy();
  });

  it("no reason, or a too-short one → Save stays off and nothing is saved", () => {
    render(<ManualReconcileDialog txn={out} open onCancel={() => {}} onDone={() => {}} />);
    expect(saveBtn().disabled).toBe(true);
    fireEvent.change(reason(), { target: { value: "abc " } });
    expect(saveBtn().disabled).toBe(true);
    fireEvent.click(saveBtn());
    expect(state.save).not.toHaveBeenCalled();
  });

  it("Cancel changes nothing", () => {
    const onCancel = vi.fn();
    render(<ManualReconcileDialog txn={out} open onCancel={onCancel} onDone={() => {}} />);
    fireEvent.change(reason(), { target: { value: "RTGS failed, came back" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
    expect(state.save).not.toHaveBeenCalled();
  });

  it("a reason → saves this line only, with the reason", async () => {
    const onDone = vi.fn();
    render(<ManualReconcileDialog txn={out} open onCancel={() => {}} onDone={onDone} />);
    expect(screen.getByText(/No open money-in line of ₹12,00,000/)).toBeTruthy();
    fireEvent.change(reason(), { target: { value: "Bank charge reversed by bank" } });
    expect(saveBtn().disabled).toBe(false);
    fireEvent.click(saveBtn());
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(state.save).toHaveBeenCalledWith({ transactionId: "t-out", reason: "Bank charge reversed by bank", reversalId: null });
  });

  it("pair with the reversal line → both lines saved together", async () => {
    state.candidates = [back];
    const onDone = vi.fn();
    render(<ManualReconcileDialog txn={out} open onCancel={() => {}} onDone={onDone} />);
    fireEvent.change(reason(), { target: { value: "RTGS failed, the bank returned it" } });
    expect(saveBtn().textContent).toBe("Mark reconciled");
    fireEvent.click(screen.getByRole("radio", { name: /12 Oct 2026 · \+₹12,00,000/ }));
    expect(saveBtn().textContent).toBe("Reconcile both lines");
    fireEvent.click(saveBtn());
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(state.save).toHaveBeenCalledWith({ transactionId: "t-out", reason: "RTGS failed, the bank returned it", reversalId: "t-back" });
  });

  it("a refused save keeps the dialog open", async () => {
    state.save.mockRejectedValue(new Error("refused"));
    const onDone = vi.fn();
    render(<ManualReconcileDialog txn={out} open onCancel={() => {}} onDone={onDone} />);
    fireEvent.change(reason(), { target: { value: "Bank charge reversed" } });
    fireEvent.click(saveBtn());
    await vi.waitFor(() => expect(state.save).toHaveBeenCalled());
    expect(onDone).not.toHaveBeenCalled();
  });
});
