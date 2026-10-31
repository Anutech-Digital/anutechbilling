// @vitest-environment jsdom
//
// R-2095 (staging, 30 Oct): a 130-seat subscription for tattvaspa.org was saved on tattvaspa.com.
// Adding the real .com subscription was refused as a duplicate, and "Correct details" had no
// domain to fix the typo. The domain is now correctable here (cleaned like the Onboard dialog).
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { EditSubscriptionDialog } from "./edit-subscription-dialog";
import type { Subscription } from "@/lib/supabase/database.types";

const update = vi.fn(async () => ({}));
vi.mock("@/lib/queries/subscriptions", () => ({
  useUpdateSubscription: () => ({ mutateAsync: update, isPending: false }),
  useCorrectSubscriptionTerms: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCorrectSubscriptionCommitment: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useScheduleInvoices: () => ({ data: undefined }),
}));
vi.mock("@/lib/queries/items", () => ({ useItems: () => ({ data: [] }) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "owner" } }) }));
vi.mock("./suspend-subscription-dialog", () => ({
  MIN_SUSPEND_REASON: 3,
  useSuspendSubscription: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

afterEach(cleanup);

const sub = {
  id: "sub-1", tenant_id: "t1", customer_id: "c1", customer_name: "Elementia",
  plan: "Google Workspace Business Starter", vendor: "google", domain: "tattvaspa.com",
  seats: 130, used: 0, mrr: 35100, status: "active",
  start_date: "2026-04-01", renewal_date: "2027-03-31", term_months: 12, billing_cycle: "yearly",
} as unknown as Subscription;

describe("R-2095 Correct details can fix a mistyped domain", () => {
  it("shows the domain and saves the corrected one, cleaned", async () => {
    render(<EditSubscriptionDialog sub={sub} open onOpenChange={() => {}} />);
    const input = document.querySelector<HTMLInputElement>("#sub_domain");
    expect(input?.value).toBe("tattvaspa.com");
    fireEvent.change(input!, { target: { value: " https://TattvaSpa.org/ " } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    const arg = (update.mock.calls[0] as unknown as [{ patch: Record<string, unknown> }])[0];
    expect(arg.patch.domain).toBe("tattvaspa.org");
  });
});
