// @vitest-environment jsdom
/* R-2401 — the owner's path (Pardeep, 3 Nov, Renewals "Expired · in grace"): the card's buttons
   say what they do, and "Customer not renewing" opens Cancel after the renewal date and Won't
   renew before it — the existing dialogs.
   R-2422 — the row shows ONE next-step button; the rest sit in the ⋯ menu (R-2408 pattern). */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => async () => false, useAskText: () => async () => null }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "owner", tenantGracePeriodDays: 15 } }) }));
vi.mock("@/lib/queries/subscriptions", () => ({
  useOpenRenewalQuotes: () => ({ data: [] }),
  useCancelSubscription: () => ({ mutate: vi.fn(), isPending: false }),
  useSubscriptionInvoices: () => ({ data: [], isLoading: false, isError: false }),
}));
vi.mock("@/components/features/subscriptions/use-non-renewing", () => ({
  useSetNonRenewing: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/components/features/invoices/issue-credit-note-dialog", () => ({ IssueCreditNoteDialog: () => null }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/components/shared/ai-draft-button", () => ({ AiDraftButton: () => null }));
vi.mock("@/components/shared/voice-note-button", () => ({ useVoiceNoteSend: () => ({ send: vi.fn(), sending: false }) }));

import { RenewalActions, type RenewalActionsSub } from "./renewal-actions";

const SUB: RenewalActionsSub = {
  id: "sub-1", customer_name: "REDOQ", plan: "Workspace Business", status: "active", renewal_state: "grace_period",
  renewal_date: "2026-10-28", term_months: 12, auto_renew: true, renewal_quote_id: null, billing_cycle: "yearly",
  grace_until: null, outstanding_amount: 0, start_date: "2025-10-28", quote_id: "Q-1",
};

afterEach(cleanup);

/* R-2422: everything but the next-step button sits in the row's ⋯ menu (Radix opens on keys in jsdom). */
function openMenu() {
  const trigger = screen.getByRole("button", { name: /More actions for/ });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.keyDown(trigger, { key: "Enter" });
}

describe("R-2401 RenewalActions", () => {
  it("expired in grace: Send renewal quote; ⋯ has Create quote (don't send) / Customer not renewing", () => {
    render(<RenewalActions sub={SUB} daysUntil={-6} layout="card" />);
    expect(screen.getByRole("button", { name: /Send renewal quote/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Generate/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Send now/ })).toBeNull();
    openMenu();
    expect(screen.getByRole("menuitem", { name: /Create quote \(don't send\)/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Customer not renewing/ })).toBeTruthy();
  });

  it("after the renewal date, Customer not renewing opens Cancel subscription (with a reason)", () => {
    render(<RenewalActions sub={SUB} daysUntil={-6} layout="card" />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Customer not renewing/ }));
    expect(screen.getByText("Cancel subscription", { selector: "h2" })).toBeTruthy();
    expect(screen.getByLabelText(/Reason/)).toBeTruthy();
    /* The renewal date has passed — "At end of term" is not offered. */
    expect(screen.queryByText(/At end of term/)).toBeNull();
  });

  it("before the renewal date, it opens Won't renew", () => {
    render(<RenewalActions sub={{ ...SUB, renewal_date: "2026-11-08", renewal_state: "notice_sent" }} daysUntil={5} layout="table" />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Customer not renewing/ }));
    expect(screen.getByText("Won't renew", { selector: "h2" })).toBeTruthy();
  });

  it("grace over: Renew anyway and Cancel side by side", () => {
    render(<RenewalActions sub={{ ...SUB, renewal_date: "2026-10-01" }} daysUntil={-33} layout="table" />);
    const box = screen.getByTestId("grace-over-choice");
    expect(box.textContent).toMatch(/Renew anyway/);
    expect(box.textContent).toMatch(/Cancel/);
  });

  it("R-2422: one next-step button + ⋯ — Follow-up / Nudge / Voice are menu items, not more buttons", () => {
    const onFollowup = vi.fn();
    render(<RenewalActions sub={{ ...SUB, customer_id: "c-1" }} daysUntil={-6} layout="table" onFollowup={onFollowup} messaging />);
    const buttons = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent ?? "");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toMatch(/Send renewal quote/);
    expect(buttons[1]).toMatch(/More actions for REDOQ/);
    openMenu();
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent?.trim());
    expect(items).toEqual(["Create quote (don't send)", "Follow-up", "Nudge", "Voice note", "Customer not renewing"]);
    fireEvent.click(screen.getByRole("menuitem", { name: /Follow-up/ }));
    expect(onFollowup).toHaveBeenCalledTimes(1);
  });

  it("R-2422: nothing left to send → the one button is Follow-up", () => {
    const onFollowup = vi.fn();
    render(<RenewalActions sub={{ ...SUB, auto_renew: false, customer_id: "c-1" }} daysUntil={-6} layout="table" onFollowup={onFollowup} />);
    fireEvent.click(screen.getByRole("button", { name: /Log a follow-up for REDOQ/ }));
    expect(onFollowup).toHaveBeenCalledTimes(1);
  });
});
