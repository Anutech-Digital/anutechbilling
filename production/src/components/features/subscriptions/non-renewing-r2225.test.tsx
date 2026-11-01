// @vitest-environment jsdom
/* R-2225 (Zoho Billing audit A1): "Won't renew" in the drawer (with Undo) and Cancel → Now / At end
   of term. The owner's path: the customer rings, says "we won't renew in December" — the owner
   records it in two clicks and the subscription runs to its renewal date, then ends. */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const cancelMutate = vi.fn();
const nrMutate = vi.fn();
vi.mock("@/lib/queries/subscriptions", () => ({
  useCancelSubscription: () => ({ mutate: cancelMutate, isPending: false }),
  useSubscriptionInvoices: () => ({ data: [], isLoading: false, isError: false }),
}));
vi.mock("./use-non-renewing", () => ({
  useSetNonRenewing: () => ({ mutate: nrMutate, isPending: false }),
}));
vi.mock("@/components/features/invoices/issue-credit-note-dialog", () => ({ IssueCreditNoteDialog: () => null }));
vi.mock("@/lib/dates/ist", async (orig) => ({ ...(await orig<object>()), istToday: () => "2026-11-01" }));

import { CancelSubscriptionDialog } from "./cancel-subscription-dialog";
import { NonRenewingDialog } from "./non-renewing-dialog";
import { SubDrawerDangerZone, SubDrawerNonRenewing } from "./sub-drawer-actions";

const SUB = {
  id: "sub-1", customer_name: "E2E Test Co", plan: "Business Starter", outstanding_amount: 0,
  start_date: "2025-12-16", quote_id: "Q-1", renewal_quote_id: null,
  status: "active", auto_renew: true, renewal_date: "2026-12-15",
};

beforeEach(() => { cancelMutate.mockReset(); nrMutate.mockReset(); });
afterEach(cleanup);

describe("Won't renew dialog", () => {
  it("says what happens, needs a reason, and sends reason + the date the customer said it", () => {
    render(<NonRenewingDialog sub={SUB} open onOpenChange={() => {}} />);
    expect(screen.getByText(/runs till 15 Dec 2026, then ends/)).toBeTruthy();
    const btn = screen.getByRole("button", { name: "Mark Won't renew" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Why/), { target: { value: "Moving to Microsoft 365" } });
    fireEvent.change(screen.getByLabelText(/Date the customer told you/), { target: { value: "2026-10-30" } });
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(nrMutate).toHaveBeenCalledWith(
      { id: "sub-1", on: true, reason: "Moving to Microsoft 365", saidOn: "2026-10-30" },
      expect.anything(),
    );
  });

  it("a future 'told on' date is refused on screen", () => {
    render(<NonRenewingDialog sub={SUB} open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Why/), { target: { value: "Moving to Microsoft 365" } });
    fireEvent.change(screen.getByLabelText(/Date the customer told you/), { target: { value: "2026-11-05" } });
    expect(screen.getByText(/in the future/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Mark Won't renew" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("drawer: Won't renew button, and the Non-renewing note with Undo", () => {
  it("a renewing subscription shows 'Won't renew' (not red) above Cancel", () => {
    const onWontRenew = vi.fn();
    render(<SubDrawerDangerZone cancelledNote={null} canDelete={false} onCancel={() => {}} onDelete={() => {}} onWontRenew={onWontRenew} />);
    const b = screen.getByRole("button", { name: "Won't renew" });
    expect(b.className).not.toMatch(/text-rose/);
    fireEvent.click(b);
    expect(onWontRenew).toHaveBeenCalledOnce();
  });

  it("no handler (non-renewing already, or ended) → no button", () => {
    render(<SubDrawerDangerZone cancelledNote={null} canDelete={false} onCancel={() => {}} onDelete={() => {}} />);
    expect(screen.queryByRole("button", { name: "Won't renew" })).toBeNull();
  });

  it("the note names the end date and what the customer said; Undo calls back", () => {
    const onUndo = vi.fn();
    render(<SubDrawerNonRenewing
      sub={{ ...SUB, auto_renew: false, non_renew_reason: "Moving to Microsoft 365", non_renew_said_on: "2026-10-30" }}
      onUndo={onUndo} undoing={false} />);
    expect(screen.getByText("Non-renewing · ends 15 Dec 2026")).toBeTruthy();
    expect(screen.getByText(/Customer said on 30 Oct 2026: Moving to Microsoft 365/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo Won't renew" }));
    expect(onUndo).toHaveBeenCalledOnce();
  });

  it("renders nothing for a renewing subscription", () => {
    const { container } = render(<SubDrawerNonRenewing sub={SUB} onUndo={() => {}} undoing={false} />);
    expect(container.textContent).toBe("");
  });
});

describe("Cancel dialog: Now vs At end of term", () => {
  it("offers both; At end of term marks Won't renew (no cancel, no last-day field)", () => {
    render(<CancelSubscriptionDialog sub={SUB} open onOpenChange={() => {}} />);
    const now = screen.getByLabelText(/^Now/) as HTMLInputElement;
    const end = screen.getByLabelText(/At end of term/) as HTMLInputElement;
    expect(now.checked).toBe(true);
    expect(screen.getByText(/15 Dec 2026/)).toBeTruthy();
    fireEvent.click(end);
    expect(document.getElementById("cancel-sub-last-day")).toBeNull();
    fireEvent.change(document.getElementById("cancel-sub-reason")!, { target: { value: "Closing the business" } });
    fireEvent.click(screen.getByRole("button", { name: "Stop at end of term" }));
    expect(nrMutate).toHaveBeenCalledWith(
      { id: "sub-1", on: true, reason: "Closing the business", saidOn: "2026-11-01" },
      expect.anything(),
    );
    expect(cancelMutate).not.toHaveBeenCalled();
  });

  it("Now still cancels as before", () => {
    render(<CancelSubscriptionDialog sub={SUB} open onOpenChange={() => {}} />);
    fireEvent.change(document.getElementById("cancel-sub-reason")!, { target: { value: "Closing the business" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel subscription" }));
    expect(cancelMutate).toHaveBeenCalledOnce();
    expect(nrMutate).not.toHaveBeenCalled();
  });

  it("no term end to stop at (no renewal date / already non-renewing) → no choice shown", () => {
    render(<CancelSubscriptionDialog sub={{ ...SUB, renewal_date: null }} open onOpenChange={() => {}} />);
    expect(screen.queryByLabelText(/At end of term/)).toBeNull();
    cleanup();
    render(<CancelSubscriptionDialog sub={{ ...SUB, auto_renew: false }} open onOpenChange={() => {}} />);
    expect(screen.queryByLabelText(/At end of term/)).toBeNull();
  });
});
