// @vitest-environment jsdom
/* R-2859 — staging 16 Nov (Renewals → Overdue): the Bill together box offered ONE bill for a customer's two
   subscriptions while each of the two rows ("Bills with …") still had its own Bill next part — two ways for one
   job and a risk of two proformas. The row of a suggested group now has ONE button, Bill together (the box's
   dialog, with the subscriptions still ticked); Bill next part for one alone is in ⋯. Unticked to under two in
   the box → the row keeps its own button. */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const push = vi.fn();
const useCurrentUser = vi.fn(() => ({ data: { role: "owner", tenantGracePeriodDays: 15 } }));
const useOpenRenewalQuotes = vi.fn(() => ({ data: [], isLoading: false }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }), useQuery: () => ({ data: undefined, isPending: true, isError: false }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
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
import { togetherRowButton } from "./bill-together";
import { renewalStage } from "@/lib/renewals/stage";
import type { BillTogetherGroup } from "@/lib/renewals/bill-together";

const G: BillTogetherGroup = { customerId: "c-it", customerName: "ITBUZZ Technologies", subIds: ["std", "sta"], why: "same-bill", kind: "parts" };
const G3: BillTogetherGroup = { ...G, subIds: ["std", "sta", "ent"] };
const HINT = { group: G, text: "Bills with Business Starter" };

/** Monthly part that started 12 Nov, not billed — the row's own button is Bill next part. */
const SUB: RenewalActionsSub = {
  id: "std", customer_name: "ITBUZZ Technologies", plan: "Business Standard", status: "active", renewal_state: "notice_sent",
  renewal_date: "2026-11-12", term_months: 12, auto_renew: true, renewal_quote_id: null, billing_cycle: "quarterly",
  grace_until: null, outstanding_amount: 0, start_date: "2025-11-12", quote_id: "Q-1",
};
const STAGE = renewalStage({ sub: SUB as never, todayIst: "2026-11-14" });
const VIEWER = { role: "owner", tenantGracePeriodDays: 15 };

beforeEach(() => { push.mockReset(); useCurrentUser.mockClear(); });
afterEach(() => cleanup());

describe("R-2859 togetherRowButton", () => {
  it("two ticked → Bill together, opening the dialog with exactly the ticked subscriptions", () => {
    const open = vi.fn();
    const b = togetherRowButton(HINT, "std", new Set(), open);
    expect(b).toMatchObject({ kind: "parts", label: "Bill together" });
    expect(b!.title).toBe("Bill together — one proforma for 2 subscriptions of ITBUZZ Technologies (you check the lines first). To bill only this one, use Bill next part in More actions (⋯).");
    b!.onClick();
    expect(open).toHaveBeenCalledWith(["std", "sta"], "ITBUZZ Technologies");
  });

  it("three in the group, one unticked → a ticked row bills the two still ticked; the title never names the unticked plan", () => {
    const open = vi.fn();
    const b = togetherRowButton({ group: G3 }, "std", new Set(["ent"]), open);
    b!.onClick();
    expect(open).toHaveBeenCalledWith(["std", "sta"], "ITBUZZ Technologies");
    expect(b!.title).toContain("for 2 subscriptions");
    expect(b!.title).not.toContain("Enterprise");
  });

  it("the UNTICKED row of that group keeps its own button — its row never bills the others without it", () => {
    const open = vi.fn();
    expect(togetherRowButton({ group: G3 }, "ent", new Set(["ent"]), open)).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it("the availability check is still out → the button is there but marked pending (not pressable)", () => {
    expect(togetherRowButton(HINT, "std", new Set(), vi.fn(), true)).toMatchObject({ label: "Bill together", pending: true });
    expect(togetherRowButton(HINT, "std", new Set(), vi.fn())!.pending).toBe(false);
  });

  it("under two ticked → null: the row keeps its own button", () => {
    expect(togetherRowButton(HINT, "std", new Set(["sta"]), vi.fn())).toBeNull();
  });

  it("no hint for the row (not suggested, or Bill together is off for this login) → null", () => {
    expect(togetherRowButton(null, "std", new Set(), vi.fn())).toBeNull();
    expect(togetherRowButton(undefined, "std", new Set(), vi.fn())).toBeNull();
  });

  it("a yearly group → one renewal quote; one alone = Send renewal in ⋯", () => {
    const b = togetherRowButton({ group: { ...G, kind: "renewal" } }, "std", new Set(), vi.fn());
    expect(b).toMatchObject({ kind: "renewal", label: "Bill together" });
    expect(b!.title).toContain("one renewal quote for 2 subscriptions of ITBUZZ Technologies");
    expect(b!.title).toContain("use Send renewal in More actions (⋯)");
  });
});

describe("R-2859 the row's ONE button", () => {
  it("without a suggestion the row's button is its own Bill next part (as before)", () => {
    render(<RenewalActions sub={SUB} daysUntil={-2} layout="table" stage={STAGE} viewer={VIEWER} payHref={null} />);
    expect(screen.getByTestId("stage-primary").textContent).toContain("Bill next part");
  });

  it("row button opens Bill together — never the single Bill next part dialog, and no second button", () => {
    const open = vi.fn();
    render(<RenewalActions sub={SUB} daysUntil={-2} layout="table" stage={STAGE} viewer={VIEWER} payHref={null}
      together={togetherRowButton(HINT, "std", new Set(), open)} />);
    const btn = screen.getByTestId("stage-primary");
    expect(btn.textContent).toContain("Bill together");
    expect(btn.textContent).not.toContain("Bill next part");
    expect(screen.getAllByRole("button", { name: /Bill/ })).toHaveLength(1);
    expect(btn.getAttribute("title")).toMatch(/^Bill together — one proforma for 2 subscriptions/);
    fireEvent.click(btn);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(["std", "sta"], "ITBUZZ Technologies");
    /* the single-subscription flow was not started: the full row (its hooks, the Bill next part dialog) never mounted */
    expect(useCurrentUser).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("under two ticked in the box → the row is back on its own Bill next part", () => {
    render(<RenewalActions sub={SUB} daysUntil={-2} layout="table" stage={STAGE} viewer={VIEWER} payHref={null}
      together={togetherRowButton(HINT, "std", new Set(["sta"]), vi.fn())} />);
    expect(screen.getByTestId("stage-primary").textContent).toContain("Bill next part");
  });

  it("disabled while loading — the viewer is still being read → Bill together cannot be pressed", () => {
    const open = vi.fn();
    render(<RenewalActions sub={SUB} daysUntil={-2} layout="table" stage={STAGE} viewer={null} payHref={null}
      together={togetherRowButton(HINT, "std", new Set(), open)} />);
    const btn = screen.getByTestId("stage-primary") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(open).not.toHaveBeenCalled();
  });

  it("a row whose button is not Bill next part (the part is already sent) keeps it — no Bill together", () => {
    const sent = renewalStage({ sub: SUB as never, todayIst: "2026-11-14", doc: { kind: "part", quoteId: "PI-1", status: "sent", dueDate: "2026-11-12", period: "12 Nov – 11 Feb" } });
    render(<RenewalActions sub={SUB} daysUntil={-2} layout="table" stage={sent} viewer={VIEWER} payHref={null} onFollowup={vi.fn()}
      together={togetherRowButton(HINT, "std", new Set(), vi.fn())} />);
    expect(screen.getByTestId("stage-primary").textContent).not.toContain("Bill together");
  });

  it("availability check still out → Bill together shows from the first paint but cannot be pressed (no swap under a click)", () => {
    const open = vi.fn();
    render(<RenewalActions sub={SUB} daysUntil={-2} layout="table" stage={STAGE} viewer={VIEWER} payHref={null}
      together={togetherRowButton(HINT, "std", new Set(), open, true)} />);
    const btn = screen.getByTestId("stage-primary") as HTMLButtonElement;
    expect(btn.textContent).toContain("Bill together");
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(open).not.toHaveBeenCalled();
  });

  it("yearly group: the row's Send renewal becomes Bill together", () => {
    const open = vi.fn();
    const yearly: RenewalActionsSub = { ...SUB, billing_cycle: "yearly", renewal_date: "2026-11-30", start_date: "2025-12-01" };
    const stage = renewalStage({ sub: yearly as never, todayIst: "2026-11-14" });
    render(<RenewalActions sub={yearly} daysUntil={16} layout="table" stage={stage} viewer={VIEWER} payHref={null}
      together={togetherRowButton({ group: { ...G, kind: "renewal" } }, "std", new Set(), open)} />);
    const btn = screen.getByTestId("stage-primary");
    expect(btn.textContent).toContain("Bill together");
    expect(btn.textContent).not.toContain("Send renewal");
    fireEvent.click(btn);
    expect(open).toHaveBeenCalledWith(["std", "sta"], "ITBUZZ Technologies");
  });

  it("card layout (phone) shows the same ONE button", () => {
    const open = vi.fn();
    render(<RenewalActions sub={SUB} daysUntil={-2} layout="card" stage={STAGE} viewer={VIEWER} payHref={null}
      together={togetherRowButton(HINT, "std", new Set(), open)} />);
    fireEvent.click(screen.getByTestId("stage-primary"));
    expect(open).toHaveBeenCalledWith(["std", "sta"], "ITBUZZ Technologies");
  });
});
