// @vitest-environment jsdom
/* R-2764 (R-2742 PERF-1): on /renewals a row's button + ⋯ render WITHOUT the row's own hooks (user read,
   open renewal quotes, router, confirm, mutations); the full component mounts on the first click and
   runs THAT click once. Payment Follow-up (no viewer) keeps the full component. */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

const push = vi.fn();
const useCurrentUser = vi.fn(() => ({ data: { role: "owner", tenantGracePeriodDays: 15 } }));
const useOpenRenewalQuotes = vi.fn(() => ({ data: [], isLoading: false }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => async () => false, useAskText: () => async () => null }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => useCurrentUser() }));
vi.mock("@/lib/queries/subscriptions", () => ({
  useOpenRenewalQuotes: () => useOpenRenewalQuotes(),
  useCancelSubscription: () => ({ mutate: vi.fn(), isPending: false }),
  useSubscriptionInvoices: () => ({ data: [], isLoading: false, isError: false }),
}));
vi.mock("@/components/features/subscriptions/use-non-renewing", () => ({ useSetNonRenewing: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/components/features/invoices/issue-credit-note-dialog", () => ({ IssueCreditNoteDialog: () => null }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/quotes/start-revision", () => ({ openRenewalRevision: vi.fn() }));
vi.mock("@/components/shared/ai-draft-button", () => ({ AiDraftButton: () => null }));
vi.mock("@/components/shared/voice-note-button", () => ({ useVoiceNoteSend: () => ({ send: vi.fn(), sending: false }) }));

import { RenewalActions, type RenewalActionsSub } from "./renewal-actions";
import { renewalStage } from "@/lib/renewals/stage";

const SUB: RenewalActionsSub = {
  id: "sub-1", customer_name: "FORZA MEDI", plan: "Domain Registration .com", status: "active", renewal_state: "notice_sent",
  renewal_date: "2026-11-30", term_months: 12, auto_renew: true, renewal_quote_id: null, billing_cycle: "yearly",
  grace_until: null, outstanding_amount: 0, start_date: "2025-12-01", quote_id: "Q-1",
};
const STAGE = renewalStage({ sub: SUB as never, todayIst: "2026-11-14" });
const VIEWER = { role: "owner", tenantGracePeriodDays: 15 };

const fetchMock = vi.fn();
beforeEach(() => {
  push.mockReset(); fetchMock.mockReset(); useCurrentUser.mockClear(); useOpenRenewalQuotes.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("R-2764 lazy RenewalActions", () => {
  it("renders the stage button with no per-row user / open-quote read", () => {
    render(<RenewalActions sub={SUB} daysUntil={16} layout="table" stage={STAGE} viewer={VIEWER} payHref={null} />);
    expect(screen.getByTestId("stage-primary")).toBeTruthy();
    expect(useCurrentUser).not.toHaveBeenCalled();
    expect(useOpenRenewalQuotes).not.toHaveBeenCalled();
  });

  it("the first click mounts the full row and runs that click exactly once", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ quoteId: "Q-NEW", quoteStatus: "draft" }), { status: 200 }));
    render(<RenewalActions sub={SUB} daysUntil={16} layout="table" stage={STAGE} viewer={VIEWER} payHref={null} />);
    fireEvent.click(screen.getByTestId("stage-primary"));
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(String(push.mock.calls[0][0])).toMatch(/^\/quotes\/Q-NEW\/edit/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useCurrentUser).toHaveBeenCalled();
  });

  it("viewer still being read (null) → the button shows but is disabled, no per-row read", () => {
    render(<RenewalActions sub={SUB} daysUntil={16} layout="table" stage={STAGE} viewer={null} payHref={null} />);
    expect((screen.getByTestId("stage-primary") as HTMLButtonElement).disabled).toBe(true);
    expect(useCurrentUser).not.toHaveBeenCalled();
  });

  it("the armed click waits until the user is read (never Send before Review is known)", async () => {
    useCurrentUser.mockReturnValue({ data: undefined } as never);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ quoteId: "Q-NEW", quoteStatus: "draft" }), { status: 200 }));
    const { rerender } = render(<RenewalActions sub={SUB} daysUntil={16} layout="table" stage={STAGE} viewer={VIEWER} payHref={null} />);
    fireEvent.click(screen.getByTestId("stage-primary"));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    useCurrentUser.mockReturnValue({ data: { role: "owner", tenantGracePeriodDays: 15 } });
    rerender(<RenewalActions sub={SUB} daysUntil={16} layout="table" stage={STAGE} viewer={VIEWER} payHref={null} />);
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("without a viewer (Payment Follow-up) the full component renders as before", () => {
    render(<RenewalActions sub={SUB} daysUntil={16} layout="table" stage={STAGE} payHref={null} />);
    expect(screen.getByTestId("stage-primary")).toBeTruthy();
    expect(useCurrentUser).toHaveBeenCalled();
  });
});
