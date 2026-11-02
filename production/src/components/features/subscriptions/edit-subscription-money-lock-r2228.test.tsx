// @vitest-environment jsdom
//
// R-2228 (Zoho Billing audit A4): "Correct details" let anyone change seats, MRR and status with
// no bill or credit, so the subscription, its invoices and Google drifted apart. Now seats / MRR /
// status are read-only with links to the right action; the owner alone has a "Data correction"
// path for seats / MRR, with a reason of 10+ characters.
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { EditSubscriptionDialog } from "./edit-subscription-dialog";
import type { Subscription } from "@/lib/supabase/database.types";

const correct = vi.fn();
const dataFix = vi.fn();
const update = vi.fn();
let role = "owner";

vi.mock("@/lib/queries/subscriptions", () => ({
  useUpdateSubscription: () => ({ mutateAsync: update, isPending: false }),
  useCorrectSubscriptionTerms: () => ({ mutateAsync: correct, isPending: false }),
  useCorrectSubscriptionData: () => ({ mutateAsync: dataFix, isPending: false }),
  useCorrectSubscriptionCommitment: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useScheduleInvoices: () => ({ data: { sale: null, instalments: [], renewals: [], addSeats: [] } }),
}));
vi.mock("@/lib/queries/items", () => ({ useItems: () => ({ data: [] }) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role } }) }));
vi.mock("./suspend-subscription-dialog", () => ({
  MIN_SUSPEND_REASON: 3,
  useSuspendSubscription: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/dates/ist", async (orig) => ({
  ...(await orig<typeof import("@/lib/dates/ist")>()),
  istToday: () => "2026-11-01",
}));

beforeEach(() => { correct.mockReset(); dataFix.mockReset(); update.mockReset(); role = "owner"; });
afterEach(cleanup);

const sub = {
  id: "sub-1", tenant_id: "t1", customer_id: "c1", customer_name: "E2E Test Co",
  plan: "Google Workspace Business Standard", item_id: null, vendor: "google", domain: "e2etest.com",
  seats: 15, used: 0, mrr: 16_200, status: "active", quote_id: "Q-1",
  start_date: "2026-10-01", renewal_date: "2027-10-01", term_months: 12, billing_cycle: "yearly",
} as unknown as Subscription;

const save = () => fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

describe("R-2228: Correct details — seats, MRR and status are locked", () => {
  it("seats, MRR and status are read-only: no inputs, no status picker", () => {
    render(<EditSubscriptionDialog sub={sub} open onOpenChange={() => {}} />);
    expect(document.querySelector("#sub_seats")).toBeNull();
    expect(document.querySelector("#sub_mrr")).toBeNull();
    expect(document.querySelector("#sub_status")).toBeNull();
    expect(screen.getByTestId("sub-seats-readonly").textContent).toContain("15");
    expect(screen.getByTestId("sub-status-readonly").textContent).toMatch(/active/i);
  });

  it("MRR is shown as derived: seats × rate per seat per month", () => {
    render(<EditSubscriptionDialog sub={sub} open onOpenChange={() => {}} />);
    const mrr = screen.getByTestId("sub-mrr-readonly").textContent ?? "";
    expect(mrr).toContain("16,200");
    expect(mrr).toMatch(/15 seats × ₹1,080/);
  });

  it("links to the right action: Manage seats, Suspend, Cancel, Won't renew", () => {
    const actions = { manageSeats: vi.fn(), suspend: vi.fn(), cancel: vi.fn(), wontRenew: vi.fn() };
    render(<EditSubscriptionDialog sub={sub} open onOpenChange={() => {}} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Manage seats" }));
    fireEvent.click(screen.getByRole("button", { name: "Suspend" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel subscription" }));
    fireEvent.click(screen.getByRole("button", { name: "Won't renew" }));
    expect(actions.manageSeats).toHaveBeenCalledTimes(1);
    expect(actions.suspend).toHaveBeenCalledTimes(1);
    expect(actions.cancel).toHaveBeenCalledTimes(1);
    expect(actions.wontRenew).toHaveBeenCalledTimes(1);
  });

  it("a paused subscription offers Resume, not Suspend", () => {
    const actions = { suspend: vi.fn(), resume: vi.fn() };
    render(<EditSubscriptionDialog sub={{ ...sub, status: "paused" } as Subscription} open onOpenChange={() => {}} actions={actions} />);
    expect(screen.queryByRole("button", { name: "Suspend" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(actions.resume).toHaveBeenCalledTimes(1);
  });

  it("a typo fix (domain) still saves — and the table write carries no seats, MRR or status", async () => {
    render(<EditSubscriptionDialog sub={sub} open onOpenChange={() => {}} />);
    fireEvent.change(document.querySelector("#sub_domain")!, { target: { value: "e2etest.in" } });
    save();
    await vi.waitFor(() => expect(update).toHaveBeenCalled());
    const patch = update.mock.calls[0][0].patch;
    expect(patch.domain).toBe("e2etest.in");
    expect(patch).not.toHaveProperty("seats");
    expect(patch).not.toHaveProperty("mrr");
    expect(patch).not.toHaveProperty("status");
    expect(correct).not.toHaveBeenCalled();
    expect(dataFix).not.toHaveBeenCalled();
  });
});

describe("R-2228: owner-only Data correction", () => {
  it.each(["manager", "accountant", "billing"])("a %s does not get the Data correction toggle", (r) => {
    role = r;
    render(<EditSubscriptionDialog sub={sub} open onOpenChange={() => {}} />);
    expect(screen.queryByLabelText(/Data correction \(owner\)/)).toBeNull();
    expect(document.querySelector("#sub_seats")).toBeNull();
  });

  it("the owner turns it on, fixes seats + MRR, and cannot save without a 10+ character reason", async () => {
    render(<EditSubscriptionDialog sub={sub} open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByLabelText(/Data correction \(owner\)/));
    const seats = document.querySelector<HTMLInputElement>("#sub_seats")!;
    fireEvent.change(seats, { target: { value: "12" } });
    expect(document.querySelector<HTMLInputElement>("#sub_mrr")!.value).toBe("12960");
    fireEvent.change(document.querySelector("#sub_correct_reason")!, { target: { value: "too short" } });
    save();
    await Promise.resolve();
    expect(dataFix).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    fireEvent.change(document.querySelector("#sub_correct_reason")!, { target: { value: "Zoho reconcile: Google shows 12 seats" } });
    save();
    await vi.waitFor(() => expect(dataFix).toHaveBeenCalledWith({
      id: "sub-1", seats: 12, mrr: 12_960, reason: "Zoho reconcile: Google shows 12 seats",
    }));
    expect(correct).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][0].patch).not.toHaveProperty("seats");
  });

  it("turning it off puts seats and MRR back to the record", () => {
    render(<EditSubscriptionDialog sub={sub} open onOpenChange={() => {}} />);
    const toggle = screen.getByLabelText(/Data correction \(owner\)/);
    fireEvent.click(toggle);
    fireEvent.change(document.querySelector("#sub_seats")!, { target: { value: "12" } });
    fireEvent.click(toggle);
    expect(document.querySelector("#sub_seats")).toBeNull();
    expect(screen.getByTestId("sub-seats-readonly").textContent).toContain("15");
  });
});
