// @vitest-environment jsdom
//
// R-1684 (staging T-12): "Correct details" cut an annual plan 15 → 10 seats mid-term with no
// warning, MRR stayed ₹16,200, and the plan was free text.
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { EditSubscriptionDialog } from "./edit-subscription-dialog";
import type { Subscription } from "@/lib/supabase/database.types";

const correct = vi.fn();
const update = vi.fn();
let role = "owner";

vi.mock("@/lib/queries/subscriptions", () => ({
  useUpdateSubscription: () => ({ mutateAsync: update, isPending: false }),
  useCorrectSubscriptionTerms: () => ({ mutateAsync: correct, isPending: false }),
  useScheduleInvoices: () => ({ data: { sale: { invoiceId: "INV-0073", status: "paid" }, instalments: [], renewals: [], addSeats: [] } }),
}));
vi.mock("@/lib/queries/items", () => ({ useItems: () => ({ data: [] }) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role } }) }));
vi.mock("./suspend-subscription-dialog", () => ({
  MIN_SUSPEND_REASON: 3,
  useSuspendSubscription: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/dates/ist", async (orig) => ({
  ...(await orig<typeof import("@/lib/dates/ist")>()),
  istToday: () => "2026-10-19",
}));

beforeEach(() => { correct.mockReset(); update.mockReset(); role = "owner"; });
afterEach(cleanup);

const sub = {
  id: "sub-1", tenant_id: "t1", customer_id: "c1", customer_name: "T-12 Customer",
  plan: "Google Workspace Business Standard", item_id: null, vendor: "google",
  seats: 15, used: 0, mrr: 16_200, status: "active", quote_id: "Q-1",
  start_date: "2026-10-01", renewal_date: "2027-09-30", term_months: 12, billing_cycle: "yearly",
} as unknown as Subscription;

function openDialog() {
  render(<EditSubscriptionDialog sub={sub} open onOpenChange={() => {}} />);
  return document.querySelector<HTMLInputElement>("#sub_seats")!;
}

describe("R-1684: Correct details — seats / plan / price", () => {
  it("the plan is a choice from the catalog, not a text box", () => {
    openDialog();
    const plan = document.querySelector("#sub_plan")!;
    expect(plan.tagName).not.toBe("INPUT");
  });

  it("a mid-term seat cut on an annual plan warns about money, moves MRR with the seats and names the next step", () => {
    const seats = openDialog();
    fireEvent.change(seats, { target: { value: "10" } });
    expect(document.querySelector<HTMLInputElement>("#sub_mrr")!.value).toBe("10800");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("refunds nothing");
    expect(alert.textContent).toContain("credit note");
    expect(screen.getByText(/open INV-0073 to issue a credit note/)).toBeTruthy();
  });

  it("will not save the cut without a reason; with one it goes through correct_subscription_terms", async () => {
    const seats = openDialog();
    fireEvent.change(seats, { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await Promise.resolve();
    expect(correct).not.toHaveBeenCalled();
    fireEvent.change(document.querySelector("#sub_correct_reason")!, { target: { value: "Customer removed 5 users" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await vi.waitFor(() => expect(correct).toHaveBeenCalledWith({
      id: "sub-1", itemId: null, seats: 10, mrr: 10_800, reason: "Customer removed 5 users",
    }));
    /* the table write no longer carries seats / plan / price */
    await vi.waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][0].patch).not.toHaveProperty("seats");
    expect(update.mock.calls[0][0].patch).not.toHaveProperty("plan");
  });

  it("a billing user cannot cut seats — the button is disabled and says why", () => {
    role = "billing";
    const seats = openDialog();
    fireEvent.change(seats, { target: { value: "10" } });
    expect(screen.getByText(/Only an owner or manager can cut seats/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /save changes/i }).hasAttribute("disabled")).toBe(true);
  });
});
