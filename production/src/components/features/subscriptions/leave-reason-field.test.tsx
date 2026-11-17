// @vitest-environment jsdom
/* R-2243 — Cancel and Won't renew ask WHY with the same picklist; a reason is required, "Other" needs a note,
   and the code goes to the server next to the readable sentence. */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const cancelMutate = vi.fn();
const nrMutate = vi.fn();
vi.mock("@/lib/queries/subscriptions", () => ({
  useCancelSubscription: () => ({ mutate: cancelMutate, isPending: false }),
  useSubscriptionInvoices: () => ({ data: [], isLoading: false, isError: false }),
}));
vi.mock("./use-non-renewing", () => ({ useSetNonRenewing: () => ({ mutate: nrMutate, isPending: false }) }));
vi.mock("@/components/features/invoices/issue-credit-note-dialog", () => ({ IssueCreditNoteDialog: () => null }));
vi.mock("@/lib/dates/ist", () => ({ istToday: () => "2026-11-17" }));

import { CancelSubscriptionDialog } from "./cancel-subscription-dialog";
import { NonRenewingDialog } from "./non-renewing-dialog";
import { LEAVE_REASONS } from "@/lib/subscriptions/leave-reasons";

const SUB = {
  id: "sub-1", customer_name: "E2E Test Co", plan: "Business Starter", outstanding_amount: 0,
  start_date: "2025-12-16", quote_id: "Q-1", renewal_quote_id: null,
  status: "active" as const, auto_renew: true, renewal_date: "2026-12-15" as string | null,
};

beforeEach(() => { cancelMutate.mockReset(); nrMutate.mockReset(); });
afterEach(cleanup);

describe("R-2243 Cancel dialog picklist", () => {
  it("lists every reason once, in English, and starts with none picked (button off)", () => {
    render(<CancelSubscriptionDialog sub={SUB} open onOpenChange={() => {}} />);
    const sel = screen.getByLabelText(/Why is the customer leaving/) as HTMLSelectElement;
    expect(sel.value).toBe("");
    const labels = Array.from(sel.options).map((o) => o.textContent);
    expect(labels).toEqual(["Pick a reason…", ...LEAVE_REASONS.map((r) => r.label)]);
    expect((screen.getByRole("button", { name: "Cancel subscription" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a picked reason is enough (note optional) and is sent as code + sentence", () => {
    render(<CancelSubscriptionDialog sub={SUB} open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Why is the customer leaving/), { target: { value: "price" } });
    const btn = screen.getByRole("button", { name: "Cancel subscription" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(cancelMutate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sub-1", reason: "Price too high", reasonCode: "price" }),
      expect.anything(),
    );
  });

  it("Other stays off until a note of 5+ characters is written", () => {
    render(<CancelSubscriptionDialog sub={SUB} open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Why is the customer leaving/), { target: { value: "other" } });
    const btn = screen.getByRole("button", { name: "Cancel subscription" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/Note \(needed for Other/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: "Went abroad" } });
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(cancelMutate).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "Other — Went abroad", reasonCode: "other" }),
      expect.anything(),
    );
  });
});

describe("R-2243 Won't renew dialog picklist", () => {
  it("uses the same list and sends the code with the date", () => {
    render(<NonRenewingDialog sub={SUB} open onOpenChange={() => {}} />);
    const sel = screen.getByLabelText(/Why is the customer leaving/) as HTMLSelectElement;
    expect(Array.from(sel.options).slice(1).map((o) => o.value)).toEqual(LEAVE_REASONS.map((r) => r.code));
    const btn = screen.getByRole("button", { name: "Mark Won't renew" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(sel, { target: { value: "downsized" } });
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(nrMutate).toHaveBeenCalledWith(
      { id: "sub-1", on: true, reason: "Fewer users / downsizing", reasonCode: "downsized", saidOn: "2026-11-17" },
      expect.anything(),
    );
  });

  it("Other needs its note here too", () => {
    render(<NonRenewingDialog sub={SUB} open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Why is the customer leaving/), { target: { value: "other" } });
    expect((screen.getByRole("button", { name: "Mark Won't renew" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
