// @vitest-environment jsdom
//
// R-2095 (coordinator 30 Oct, P0 money): Venus Infotech is Google Workspace ANNUAL commitment paid
// MONTHLY but was booked "Monthly (Flexible)" — Correct details could not change the commitment.
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { EditSubscriptionDialog } from "./edit-subscription-dialog";
import type { Subscription } from "@/lib/supabase/database.types";

const commit = vi.fn();
const correct = vi.fn();
const update = vi.fn();
let role = "owner";

vi.mock("@/lib/queries/subscriptions", () => ({
  useUpdateSubscription: () => ({ mutateAsync: update, isPending: false }),
  useCorrectSubscriptionTerms: () => ({ mutateAsync: correct, isPending: false }),
  useCorrectSubscriptionCommitment: () => ({ mutateAsync: commit, isPending: false }),
  useScheduleInvoices: () => ({ data: undefined }),
}));
vi.mock("@/lib/queries/items", () => ({
  useItems: () => ({ data: [{
    id: "gws-std", name: "Google Workspace Business Standard", vendor: "google", kind: "main", item_type: "subscription",
    is_active: true, msrp: 300, wholesale: 264,
    prices: { annual: { msrp: 300, wholesale: 264 }, monthly: { msrp: 360, wholesale: 318 } },
  }] }),
}));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role } }) }));
vi.mock("./suspend-subscription-dialog", () => ({
  MIN_SUSPEND_REASON: 3,
  useSuspendSubscription: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/dates/ist", async (orig) => ({
  ...(await orig<typeof import("@/lib/dates/ist")>()),
  istToday: () => "2026-10-30",
}));

beforeEach(() => { commit.mockReset(); correct.mockReset(); update.mockReset(); role = "owner"; });
afterEach(cleanup);

const venus = {
  id: "sub-v", tenant_id: "t1", customer_id: "c1", customer_name: "Venus Infotech",
  plan: "Google Workspace Business Standard", item_id: "gws-std", vendor: "google", domain: "venus-test.in",
  seats: 10, used: 0, mrr: 3_000, status: "active", quote_id: "Q-1",
  start_date: "2026-06-15", renewal_date: "2026-11-14", term_months: 1, billing_cycle: "monthly",
  vendor_cost_per_seat_month: 318, vendor_synced_at: null,
} as unknown as Subscription;

const annual = { ...venus, id: "sub-a", renewal_date: "2027-06-14", term_months: 12 } as unknown as Subscription;

const select = (id: string) => document.querySelector<HTMLSelectElement>(`#${id}`)!;
const options = (id: string) => Array.from(select(id).options).map((o) => o.value);

describe("R-2095: Correct details — commitment and payment frequency", () => {
  it("shows Commitment and Payment frequency as two fields; Flexible offers monthly only", () => {
    render(<EditSubscriptionDialog sub={venus} open onOpenChange={() => {}} />);
    expect(screen.getByLabelText("Commitment")).toBe(select("sub_commitment"));
    expect(screen.getByLabelText("Payment frequency")).toBe(select("sub_frequency"));
    expect(options("sub_commitment")).toEqual(["1", "12"]);
    expect(options("sub_frequency")).toEqual(["monthly"]);
  });

  /* R-2178: renewal = the next term's start (anniversary), not start + 12m − 1d. */
  it("Flexible → Annual: all four frequencies, renewal start + 12m, cost ₹318 → ₹264, saved with a reason", async () => {
    render(<EditSubscriptionDialog sub={venus} open onOpenChange={() => {}} />);
    fireEvent.change(select("sub_commitment"), { target: { value: "12" } });
    expect(options("sub_frequency")).toEqual(["yearly", "half_yearly", "quarterly", "monthly"]);
    expect(select("sub_frequency").value).toBe("monthly");
    expect(document.querySelector<HTMLInputElement>("#sub_renewal")!.value).toBe("2027-06-15");
    expect(screen.getByTestId("commitment-cost").textContent).toMatch(/₹318.*₹264/);

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await Promise.resolve();
    expect(commit).not.toHaveBeenCalled();                     // no reason yet
    fireEvent.change(document.querySelector("#sub_correct_reason")!, { target: { value: "Annual commitment, paid monthly" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await vi.waitFor(() => expect(commit).toHaveBeenCalledWith({
      id: "sub-v", termMonths: 12, billingCycle: "monthly", renewalDate: "2027-06-15", reason: "Annual commitment, paid monthly",
    }));
    expect(correct).not.toHaveBeenCalled();                    // seats / plan / price untouched
    await vi.waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][0].patch.renewal_date).toBe("2027-06-15");
  });

  it.each(["quarterly", "half_yearly"])("annual paid monthly → %s keeps the renewal date (null = keep)", async (freq) => {
    render(<EditSubscriptionDialog sub={annual} open onOpenChange={() => {}} />);
    fireEvent.change(select("sub_frequency"), { target: { value: freq } });
    expect(document.querySelector<HTMLInputElement>("#sub_renewal")!.value).toBe("2027-06-14");
    fireEvent.change(document.querySelector("#sub_correct_reason")!, { target: { value: "Customer pays in parts" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await vi.waitFor(() => expect(commit).toHaveBeenCalledWith(expect.objectContaining({ termMonths: 12, billingCycle: freq, renewalDate: null })));
  });

  it("Annual → Flexible mid-term is refused on screen with the rule, and Save is disabled", () => {
    render(<EditSubscriptionDialog sub={annual} open onOpenChange={() => {}} />);
    fireEvent.change(select("sub_commitment"), { target: { value: "1" } });
    expect(screen.getByRole("alert").textContent).toMatch(/cannot be reduced mid-term/);
    expect((screen.getByRole("button", { name: /save changes|blocked/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});

/* R-2095 follow-up (30 Oct): Venus (Flexible, rolled monthly 15 Jun → 14 Nov) read "keeping the term
   5 months long" — the start→renewal span of a rolled sub, not its term. A Flexible sub's term is
   one month; the hint names the commitment instead. */
describe("R-2095: the start-date hint names the commitment, not the rolled span", () => {
  const hint = () => screen.getByTestId("start-term-hint").textContent ?? "";

  it("rolled Flexible sub → Flexible (monthly), never '5 months'", () => {
    render(<EditSubscriptionDialog sub={venus} open onOpenChange={() => {}} />);
    expect(hint()).toMatch(/Flexible \(monthly\)/);
    expect(hint()).not.toMatch(/5 months/);
  });

  it("rolled annual sub (renewed twice) → Annual commitment, never '36 months'", () => {
    render(<EditSubscriptionDialog sub={{ ...annual, start_date: "2024-06-15" } as Subscription} open onOpenChange={() => {}} />);
    expect(hint()).toMatch(/Annual commitment/);
    expect(hint()).not.toMatch(/36 months/);
  });

  it("first-term annual sub keeps the plain 12-month wording", () => {
    render(<EditSubscriptionDialog sub={annual} open onOpenChange={() => {}} />);
    expect(hint()).toMatch(/12 months long/);
  });
});
