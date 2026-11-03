// @vitest-environment jsdom
/* R-2401 — the owner's path (Pardeep, 3 Nov, Renewals "Expired · in grace"): the card's buttons
   say what they do, and "Customer not renewing" opens Cancel after the renewal date and Won't
   renew before it — the existing dialogs. */
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

import { RenewalActions, type RenewalActionsSub } from "./renewal-actions";

const SUB: RenewalActionsSub = {
  id: "sub-1", customer_name: "REDOQ", plan: "Workspace Business", status: "active", renewal_state: "grace_period",
  renewal_date: "2026-10-28", term_months: 12, auto_renew: true, renewal_quote_id: null, billing_cycle: "yearly",
  grace_until: null, outstanding_amount: 0, start_date: "2025-10-28", quote_id: "Q-1",
};

afterEach(cleanup);

describe("R-2401 RenewalActions", () => {
  it("expired in grace: Send renewal quote / Create quote (don't send) / Customer not renewing", () => {
    render(<RenewalActions sub={SUB} daysUntil={-6} layout="card" />);
    expect(screen.getByRole("button", { name: /Send renewal quote/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create quote \(don't send\)/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Generate/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Send now/ })).toBeNull();
  });

  it("after the renewal date, Customer not renewing opens Cancel subscription (with a reason)", () => {
    render(<RenewalActions sub={SUB} daysUntil={-6} layout="card" />);
    fireEvent.click(screen.getByRole("button", { name: /Customer not renewing/ }));
    expect(screen.getByText("Cancel subscription", { selector: "h2" })).toBeTruthy();
    expect(screen.getByLabelText(/Reason/)).toBeTruthy();
    /* The renewal date has passed — "At end of term" is not offered. */
    expect(screen.queryByText(/At end of term/)).toBeNull();
  });

  it("before the renewal date, it opens Won't renew", () => {
    render(<RenewalActions sub={{ ...SUB, renewal_date: "2026-11-08", renewal_state: "notice_sent" }} daysUntil={5} layout="table" />);
    fireEvent.click(screen.getByRole("button", { name: /Customer not renewing/ }));
    expect(screen.getByText("Won't renew", { selector: "h2" })).toBeTruthy();
  });

  it("grace over: Renew anyway and Cancel side by side", () => {
    render(<RenewalActions sub={{ ...SUB, renewal_date: "2026-10-01" }} daysUntil={-33} layout="table" />);
    const box = screen.getByTestId("grace-over-choice");
    expect(box.textContent).toMatch(/Renew anyway/);
    expect(box.textContent).toMatch(/Cancel/);
  });
});
