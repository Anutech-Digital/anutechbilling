// @vitest-environment jsdom
// R-2823: the vendor's own renewal date is corrected in the existing Correct details dialog (no new
// screen) and goes in the SAME one request (correct_subscription_details, R-2545).
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { EditSubscriptionDialog } from "./edit-subscription-dialog";
import { correctDetailsArgs, correctDetailsFn } from "@/lib/queries/subscriptions";
import type { Subscription } from "@/lib/supabase/database.types";

const details = vi.fn();
const onOpenChange = vi.fn();

vi.mock("@/lib/queries/subscriptions", async (orig) => ({
  correctDetailsArgs: (await orig<typeof import("@/lib/queries/subscriptions")>()).correctDetailsArgs,
  correctDetailsFn: (await orig<typeof import("@/lib/queries/subscriptions")>()).correctDetailsFn,
  useCorrectSubscriptionDetails: () => ({ mutateAsync: details, isPending: false }),
  useScheduleInvoices: () => ({ data: undefined }),
}));
vi.mock("@/lib/queries/items", () => ({ useItems: () => ({ data: [] }) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "billing" } }) }));
vi.mock("./suspend-subscription-dialog", () => ({
  MIN_SUSPEND_REASON: 3,
  useSuspendSubscription: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/dates/ist", async (orig) => ({
  ...(await orig<typeof import("@/lib/dates/ist")>()),
  istToday: () => "2026-11-15",
}));

beforeEach(() => { details.mockReset(); details.mockResolvedValue(undefined); onOpenChange.mockReset(); });
afterEach(cleanup);

const google = {
  id: "sub-g", tenant_id: "t1", customer_id: "c1", customer_name: "CT R2737 Split",
  plan: "Google Workspace Business Starter", item_id: null, vendor: "google", domain: "r2823-test.in",
  seats: 10, used: 0, mrr: 1_500, status: "active", quote_id: "Q-1",
  start_date: "2026-03-29", renewal_date: "2027-03-29", term_months: 12, billing_cycle: "yearly",
  vendor_cost_per_seat_month: 120, vendor_synced_at: null, vendor_term_end: null,
} as unknown as Subscription;

const field = () => document.querySelector<HTMLInputElement>("#sub_vendor_term");
const save = () => fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

describe("R-2823: Google renewal date in Correct details", () => {
  it("Google subscription: the field is labelled 'Google renewal date' and the date goes in the one save", async () => {
    render(<EditSubscriptionDialog sub={google} open onOpenChange={onOpenChange} />);
    expect(screen.getByLabelText("Google renewal date")).toBe(field());
    fireEvent.change(field()!, { target: { value: "2027-01-12" } });
    save();
    await vi.waitFor(() => expect(details).toHaveBeenCalledTimes(1));
    expect(details.mock.calls[0][0].patch.vendor_term_end).toBe("2027-01-12");
  });

  it("recorded date shown; cleared → null (clears it)", async () => {
    render(<EditSubscriptionDialog sub={{ ...google, vendor_term_end: "2027-01-12" } as Subscription} open onOpenChange={onOpenChange} />);
    expect(field()!.value).toBe("2027-01-12");
    fireEvent.change(field()!, { target: { value: "" } });
    save();
    await vi.waitFor(() => expect(details).toHaveBeenCalledTimes(1));
    expect(details.mock.calls[0][0].patch.vendor_term_end).toBeNull();
  });

  it("untouched: not sent (the save stays correct_subscription_details, R-2545)", async () => {
    render(<EditSubscriptionDialog sub={{ ...google, vendor_term_end: "2027-01-12" } as Subscription} open onOpenChange={onOpenChange} />);
    save();
    await vi.waitFor(() => expect(details).toHaveBeenCalledTimes(1));
    expect(details.mock.calls[0][0].patch.vendor_term_end).toBeUndefined();
    expect(correctDetailsFn(details.mock.calls[0][0])).toBe("correct_subscription_details");
  });

  it("a vendor with no own term but a stale recorded date → no field, and the save clears it", async () => {
    render(<EditSubscriptionDialog sub={{ ...google, vendor: "other", vendor_term_end: "2027-01-12" } as Subscription} open onOpenChange={onOpenChange} />);
    expect(field()).toBeNull();
    save();
    await vi.waitFor(() => expect(details).toHaveBeenCalledTimes(1));
    expect(details.mock.calls[0][0].patch.vendor_term_end).toBeNull();
    expect(correctDetailsFn(details.mock.calls[0][0])).toBe("correct_subscription_with_vendor_term");
  });

  it("a domain subscription has no vendor term → no field", () => {
    render(<EditSubscriptionDialog sub={{ ...google, vendor: "domain" } as Subscription} open onOpenChange={onOpenChange} />);
    expect(field()).toBeNull();
  });

  it("correctDetailsArgs: p_vendor_term_end only when sent", () => {
    const patch = { vendor: "google" as const, domain: null, start_date: null, renewal_date: null, payment_due_date: null };
    expect(correctDetailsArgs({ id: "s", reason: "", patch })).not.toHaveProperty("p_vendor_term_end");
    expect(correctDetailsArgs({ id: "s", reason: "", patch: { ...patch, vendor_term_end: null } })).toMatchObject({ p_vendor_term_end: null });
    expect(correctDetailsArgs({ id: "s", reason: "", patch: { ...patch, vendor_term_end: "2027-01-12" } })).toMatchObject({ p_vendor_term_end: "2027-01-12" });
  });
});
