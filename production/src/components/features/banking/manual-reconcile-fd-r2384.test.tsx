// @vitest-environment jsdom
/* R-2384 — "Mark reconciled manually" (R-2361 dialog) on a line that moves money to/from an FD:
   reconciling it without an entry leaves the FD balance wrong, so the dialog warns "use Own
   transfer". Warning only — the save still works. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { LineLike } from "@/lib/banking/manual-reconcile";

const state = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("@/lib/banking/manual-reconcile", async (orig) => ({
  ...(await orig<typeof import("@/lib/banking/manual-reconcile")>()),
  useReconcileManually: () => ({ mutateAsync: state.save, isPending: false }),
  useReversalCandidates: () => ({ data: [], isLoading: false }),
}));

import { ManualReconcileDialog } from "./manual-reconcile-dialog";

const line = (description: string): LineLike => ({
  id: "t1", bank_account_id: "acc-1", txn_date: "2026-04-10", description,
  debit: 0, credit: 100000, matched_to_type: null,
});
const WARNING = "This moves money to/from an FD — use Own transfer so the FD balance changes.";

beforeEach(() => { state.save.mockReset(); state.save.mockResolvedValue({}); });
afterEach(() => cleanup());

describe("R-2384 FD warning on Mark reconciled manually", () => {
  it.each(["FD PREMAT CLOSURE 50300012345", "AUTO SWEEP IN", "FD REDEEM 1234"])("warns on %s — and saving still works", async (d) => {
    const onDone = vi.fn();
    render(<ManualReconcileDialog txn={line(d)} open onCancel={() => {}} onDone={onDone} />);
    expect(screen.getByRole("alert").textContent).toBe(WARNING);
    fireEvent.change(screen.getByLabelText("Reason (required)"), { target: { value: "FD closed into current account" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Mark reconciled" })); });
    expect(state.save).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalled();
  });

  it("no warning on an ordinary line", () => {
    render(<ManualReconcileDialog txn={line("NEFT CR ACME PVT LTD")} open onCancel={() => {}} onDone={() => {}} />);
    expect(screen.queryByText(WARNING)).toBeNull();
  });
});
