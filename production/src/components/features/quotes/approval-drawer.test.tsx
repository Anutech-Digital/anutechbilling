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

/* Below cost → owner tier (a one-owner company). */
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
    expect(SOLE_APPROVER_PROMPT).toBe("You are the only owner — write why this price is OK");
    const box = screen.getByLabelText(SOLE_APPROVER_PROMPT) as HTMLTextAreaElement;
    expect(box.required).toBe(true);

    const approve = screen.getByRole("button", { name: "Approve as sole owner" }) as HTMLButtonElement;
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
    fireEvent.click(screen.getByRole("button", { name: "Approve as sole owner" }));
    expect(mutate.mock.calls[0][0].approvalTier).toBeUndefined();
  });

  it("with a second owner the maker is refused — no reason box, no Approve", () => {
    open([owner, { id: "o2", role: "owner" }]);
    expect(screen.queryByText(SOLE_APPROVER_PROMPT)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Approve$/ })).toBeNull();
    expect(screen.getByText(/made or revised this quote/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve as sole owner" })).toBeNull();
    expect(screen.getByText("Ask another owner to open this quote and decide.")).toBeTruthy();
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

/* R-2426 (Pardeep 3 Nov 2026): staging — a one-owner company that also has a MANAGER login.
   The owner's own below-floor quote (manager tier) said "You cannot approve your own quote.
   Ask the owner to open this quote and decide." Now only a second OWNER blocks. */
describe("R-2426: the only owner is not blocked by a manager", () => {
  const floorEconomics = { subtotal: 100_000, listTotal: 100_000, totalCost: 97_790 }; // 2.21% margin
  const floorNeed = requiredApproval(floorEconomics);
  const openFloor = (team: { id: string; role: string }[], record: ApprovalRecord) => render(
    <ApprovalDrawer
      open onOpenChange={() => {}} quoteId="Q-2" quoteLabel="Q-2"
      economics={floorEconomics} requirement={floorNeed} record={record} viewer={owner} team={team}
    />,
  );

  it("owner + manager, owner's own pending quote → reason box and 'Approve as sole owner'", () => {
    openFloor([owner, { id: "m1", role: "manager" }], rec({ status: "pending", tier: "manager", requestedBy: "o1" }));
    expect(screen.queryByText("You cannot approve your own quote.")).toBeNull();
    const approve = screen.getByRole("button", { name: "Approve as sole owner" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(SOLE_APPROVER_PROMPT), { target: { value: "Customer already paid; margin agreed" } });
    fireEvent.click(approve);
    expect(mutate.mock.calls[0][0]).toMatchObject({ id: "Q-2", decision: "approved", approvalNote: "Customer already paid; margin agreed" });
  });

  it("two owners (and a manager) → refused, told to ask ANOTHER owner", () => {
    openFloor([owner, { id: "o2", role: "owner" }, { id: "m1", role: "manager" }], rec({ status: "pending", tier: "owner", requestedBy: "o1" }));
    expect(screen.getByText("You cannot approve your own quote.")).toBeTruthy();
    expect(screen.getByText("Ask another owner to open this quote and decide.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
  });

  it("two owners, manager-tier quote (15% discount) → 'Ask a manager or another owner'", () => {
    const disc = { subtotal: 85_000, listTotal: 100_000, totalCost: 20_000 };
    const need = requiredApproval(disc);
    expect(need.tier).toBe("manager");
    render(
      <ApprovalDrawer
        open onOpenChange={() => {}} quoteId="Q-3" quoteLabel="Q-3"
        economics={disc} requirement={need} record={rec({ status: "pending", tier: "manager", requestedBy: "o1" })}
        viewer={owner} team={[owner, { id: "o2", role: "owner" }]}
      />,
    );
    expect(screen.getByText("Ask a manager or another owner to open this quote and decide.")).toBeTruthy();
  });

  it("a non-owner maker is told to ask THE owner, never 'another owner'", () => {
    const mgr = { id: "m1", role: "manager" };
    render(
      <ApprovalDrawer
        open onOpenChange={() => {}} quoteId="Q-5" quoteLabel="Q-5"
        economics={floorEconomics} requirement={floorNeed} record={rec({ status: "pending", tier: "owner", requestedBy: "m1", makers: ["m1"] })}
        viewer={mgr} team={[owner, mgr]}
      />,
    );
    expect(screen.queryByText(/another owner/)).toBeNull();
    expect(screen.getByText(/Ask (a manager or )?the owner to open this quote and decide\./)).toBeTruthy();
  });

  it("team still loading → no refusal shown to the owner yet", () => {
    render(
      <ApprovalDrawer
        open onOpenChange={() => {}} quoteId="Q-6" quoteLabel="Q-6"
        economics={floorEconomics} requirement={floorNeed} record={rec({ status: "pending", tier: "owner", requestedBy: "o1" })}
        viewer={owner} team={undefined}
      />,
    );
    expect(screen.getByText("Checking who else is an owner…")).toBeTruthy();
    expect(screen.queryByText("You cannot approve your own quote.")).toBeNull();
  });

  it("owner + manager, manager-tier quote → the only owner may still clear it", () => {
    const disc = { subtotal: 85_000, listTotal: 100_000, totalCost: 20_000 };
    render(
      <ApprovalDrawer
        open onOpenChange={() => {}} quoteId="Q-4" quoteLabel="Q-4"
        economics={disc} requirement={requiredApproval(disc)} record={rec({ status: "pending", tier: "manager", requestedBy: "o1" })}
        viewer={owner} team={[owner, { id: "m1", role: "manager" }]}
      />,
    );
    expect(screen.getByRole("button", { name: "Approve as sole owner" })).toBeTruthy();
  });
});
