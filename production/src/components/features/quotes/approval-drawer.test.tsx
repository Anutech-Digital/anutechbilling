// @vitest-environment jsdom
//
// R-2383 (owner decision 2 Nov 2026: "Haan, reason ke saath"): the company's ONLY approver
// (an owner) may approve a quote they made — but only with a written reason. The server
// trigger refuses it without one; this covers what the owner sees in the approve drawer.
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const mutate = vi.fn();
vi.mock("@/lib/queries/quotes", () => ({
  useDecideApproval: () => ({ mutate, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ApprovalDrawer, SOLE_APPROVER_PROMPT } from "./approval-drawer";
import { requiredApproval, type ApprovalRecord } from "@/lib/quotes/approval";

afterEach(cleanup);
beforeEach(() => mutate.mockReset());

/* Below cost → owner tier (Q-…-0881 Maharshi on Excel Technologies). */
const economics = { subtotal: 1_500, listTotal: 1_500, totalCost: 1_800 };
const requirement = requiredApproval(economics);
const owner = { id: "o1", role: "owner" };
const rec = (over: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  status: "not_required", tier: null, requestedBy: null, approvedBy: null,
  approvedDiscountBps: null, approvedMarginBps: null, rejectionReason: null, makers: ["o1"], ...over,
});

function open(team: { id: string; role: string }[] | undefined, viewer = owner, record = rec()) {
  return render(
    <ApprovalDrawer
      open onOpenChange={() => {}} quoteId="Q-1" quoteLabel="Q-1"
      economics={economics} requirement={requirement} record={record} viewer={viewer} team={team}
    />,
  );
}

describe("approve drawer — sole owner approving their own quote", () => {
  it("asks for a reason and keeps Approve disabled until it has 10 characters", () => {
    open([owner, { id: "s1", role: "sales" }]);
    expect(screen.getByText(SOLE_APPROVER_PROMPT)).toBeTruthy();
    expect(SOLE_APPROVER_PROMPT).toBe("You are the only approver — write why this price is OK");
    const box = screen.getByLabelText(SOLE_APPROVER_PROMPT) as HTMLTextAreaElement;
    expect(box.required).toBe(true);

    const approve = screen.getByRole("button", { name: /^Approve$/ }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.change(box, { target: { value: "too short" } });
    expect(approve.disabled).toBe(true);

    fireEvent.change(box, { target: { value: "  Strategic customer, renews at full price  " } });
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toMatchObject({
      id: "Q-1", decision: "approved", approvalNote: "Strategic customer, renews at full price",
      approvalTier: "owner", // none recorded → the tier being cleared goes along for the server
    });
  });

  it("does not resend the tier when one is recorded", () => {
    open([owner], owner, rec({ status: "pending", tier: "owner", requestedBy: "o1" }));
    fireEvent.change(screen.getByLabelText(SOLE_APPROVER_PROMPT), { target: { value: "Below cost to win the account" } });
    fireEvent.click(screen.getByRole("button", { name: /^Approve$/ }));
    expect(mutate.mock.calls[0][0].approvalTier).toBeUndefined();
  });

  it("with a second owner the maker is refused — no reason box, no Approve", () => {
    open([owner, { id: "o2", role: "owner" }]);
    expect(screen.queryByText(SOLE_APPROVER_PROMPT)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Approve$/ })).toBeNull();
    expect(screen.getByText(/made or revised this quote/)).toBeTruthy();
  });

  it("a manager who made the quote is refused even when alone", () => {
    const mgr = { id: "m1", role: "manager" };
    open([mgr], mgr, rec({ makers: ["m1"] }));
    expect(screen.queryByText(SOLE_APPROVER_PROMPT)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Approve$/ })).toBeNull();
  });

  it("another approver approving someone else's quote sees no reason box", () => {
    open([owner, { id: "o2", role: "owner" }], { id: "o2", role: "owner" });
    expect(screen.queryByText(SOLE_APPROVER_PROMPT)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Approve$/ }));
    expect(mutate.mock.calls[0][0].approvalNote).toBeUndefined();
  });

  it("an approved quote shows the sole owner's reason", () => {
    open([owner], { id: "x", role: "sales" }, rec({ status: "approved", tier: "owner", note: "Strategic customer, renews" }));
    expect(screen.getByText("Self-approved by sole owner: Strategic customer, renews")).toBeTruthy();
  });
});
