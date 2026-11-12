// @vitest-environment jsdom
/* R-2710 — Pratik's click: "Review renewal quote" opens the renewal quote in the EDITOR (nothing
   emailed); a quote the customer already has opens its revision through Change. */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

const push = vi.fn();
const openRenewalRevision = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => async () => false, useAskText: () => async () => null }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "owner", tenantGracePeriodDays: 15 } }) }));
vi.mock("@/lib/queries/subscriptions", () => ({
  useOpenRenewalQuotes: () => ({ data: [{ id: "Q-SENT", notes: null, status: "sent" }] }),
  useCancelSubscription: () => ({ mutate: vi.fn(), isPending: false }),
  useSubscriptionInvoices: () => ({ data: [], isLoading: false, isError: false }),
}));
vi.mock("@/components/features/subscriptions/use-non-renewing", () => ({ useSetNonRenewing: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/components/features/invoices/issue-credit-note-dialog", () => ({ IssueCreditNoteDialog: () => null }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/quotes/start-revision", () => ({ openRenewalRevision: (...a: unknown[]) => openRenewalRevision(...a) }));
vi.mock("@/components/shared/ai-draft-button", () => ({ AiDraftButton: () => null }));
vi.mock("@/components/shared/voice-note-button", () => ({ useVoiceNoteSend: () => ({ send: vi.fn(), sending: false }) }));

import { RenewalActions, type RenewalActionsSub } from "./renewal-actions";

const SUB: RenewalActionsSub = {
  id: "sub-1", customer_name: "FORZA MEDI", plan: "Domain Registration .com", status: "active", renewal_state: "notice_sent",
  renewal_date: "2026-11-30", term_months: 12, auto_renew: true, renewal_quote_id: null, billing_cycle: "yearly",
  grace_until: null, outstanding_amount: 0, start_date: "2025-12-01", quote_id: "Q-1",
};

const fetchMock = vi.fn();
beforeEach(() => { push.mockReset(); openRenewalRevision.mockReset(); fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("R-2710 RenewalActions", () => {
  it("Review renewal quote → generate route with review:true → /quotes/<id>/edit; no send-now call", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ quoteId: "Q-NEW", quoteStatus: "draft" }), { status: 200 }));
    render(<RenewalActions sub={SUB} daysUntil={18} layout="table" />);
    fireEvent.click(screen.getByRole("button", { name: /Review renewal quote/ }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/quotes/Q-NEW/edit"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/subscriptions/sub-1/generate-renewal-quote");
    expect(JSON.parse(String(init.body))).toEqual({ review: true });
  });

  it("the linked quote turned out to be sent → its revision opens instead (never the read-only page)", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ quoteId: "Q-OLD", quoteStatus: "sent" }), { status: 200 }));
    openRenewalRevision.mockResolvedValue({ ok: true, quoteId: "Q-OLD-R2", created: true });
    render(<RenewalActions sub={SUB} daysUntil={18} layout="table" />);
    fireEvent.click(screen.getByRole("button", { name: /Review renewal quote/ }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/quotes/Q-OLD-R2/edit"));
    expect(openRenewalRevision.mock.calls[0][1]).toBe("Q-OLD");
  });

  it("sent quote on the row → Change renewal quote opens the revision draft in the editor", async () => {
    openRenewalRevision.mockResolvedValue({ ok: true, quoteId: "Q-SENT-R2", created: true });
    render(<RenewalActions sub={{ ...SUB, renewal_quote_id: "Q-SENT" }} daysUntil={10} layout="table" />);
    fireEvent.click(screen.getByRole("button", { name: /Change renewal quote/ }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/quotes/Q-SENT-R2/edit"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Change refused (money on it) → no navigation to the editor", async () => {
    openRenewalRevision.mockResolvedValue({ ok: false, reason: "This quote has a payment or invoice, so it can't be revised." });
    render(<RenewalActions sub={{ ...SUB, renewal_quote_id: "Q-SENT" }} daysUntil={10} layout="table" />);
    fireEvent.click(screen.getByRole("button", { name: /Change renewal quote/ }));
    await waitFor(() => expect(openRenewalRevision).toHaveBeenCalled());
    expect(push).not.toHaveBeenCalled();
  });
});
