// @vitest-environment jsdom
/* R-2825: while a row's documents / viewer are still loading, its button is a visibly disabled
   "Loading…" (aria-busy + title) — never a grey block that eats the click; once ready the same click works. */
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
beforeEach(() => { push.mockReset(); fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("R-2825 Renewals buttons while loading", () => {
  it("documents still loading (stage null) → a disabled, aria-busy 'Loading…' button; clicking does nothing", async () => {
    render(<RenewalActions sub={SUB} daysUntil={16} layout="table" stage={null} viewer={VIEWER} payHref={null} />);
    const b = screen.getByTestId("stage-action-loading") as HTMLButtonElement;
    expect(b.tagName).toBe("BUTTON");
    expect(b.disabled).toBe(true);
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(b.textContent).toMatch(/Loading…/);
    expect(b.title).toMatch(/Loading/);
    fireEvent.click(b);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("viewer still being read → the stage button is disabled, aria-busy, titled 'Loading…'", () => {
    render(<RenewalActions sub={SUB} daysUntil={16} layout="table" stage={STAGE} viewer={null} payHref={null} />);
    const b = screen.getByTestId("stage-primary") as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(b.title).toMatch(/Loading/);
  });

  it("click after ready: the same row turns into the real button (no aria-busy) and the click runs once", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ quoteId: "Q-NEW", quoteStatus: "draft" }), { status: 200 }));
    const { rerender } = render(<RenewalActions sub={SUB} daysUntil={16} layout="table" stage={null} viewer={null} payHref={null} />);
    expect(screen.queryByTestId("stage-primary")).toBeNull();
    rerender(<RenewalActions sub={SUB} daysUntil={16} layout="table" stage={STAGE} viewer={VIEWER} payHref={null} />);
    const b = screen.getByTestId("stage-primary") as HTMLButtonElement;
    expect(b.disabled).toBe(false);
    expect(b.getAttribute("aria-busy")).toBeNull();
    fireEvent.click(b);
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
