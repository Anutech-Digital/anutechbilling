// @vitest-environment jsdom
//
// R-2545 (found 7 Nov 2026 on localhost, R-2543 check): on R800 Check Co, changing yearly →
// quarterly and the renewal date in ONE Correct details save — the date was refused (R-2533) but
// the payment frequency had already been saved by an earlier request. The dialog now sends ONE
// request (correct_subscription_details, one transaction); on a refusal it stays open with what
// was typed.
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { EditSubscriptionDialog } from "./edit-subscription-dialog";
import { correctDetailsArgs } from "@/lib/queries/subscriptions";
import type { Subscription } from "@/lib/supabase/database.types";

const details = vi.fn();
const onOpenChange = vi.fn();

vi.mock("@/lib/queries/subscriptions", async (orig) => ({
  correctDetailsArgs: (await orig<typeof import("@/lib/queries/subscriptions")>()).correctDetailsArgs,
  useCorrectSubscriptionDetails: () => ({ mutateAsync: details, isPending: false }),
  useScheduleInvoices: () => ({ data: undefined }),
}));
vi.mock("@/lib/queries/items", () => ({ useItems: () => ({ data: [] }) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "owner" } }) }));
vi.mock("./suspend-subscription-dialog", () => ({
  MIN_SUSPEND_REASON: 3,
  useSuspendSubscription: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/dates/ist", async (orig) => ({
  ...(await orig<typeof import("@/lib/dates/ist")>()),
  istToday: () => "2026-11-07",
}));

beforeEach(() => { details.mockReset(); onOpenChange.mockReset(); });
afterEach(cleanup);

/* The R800 shape: yearly, 12-month term, 29 Mar 2026 → 29 Mar 2027. */
const r800 = {
  id: "sub-r800", tenant_id: "t1", customer_id: "c1", customer_name: "R800 Check Co",
  plan: "Google Workspace Business Starter", item_id: null, vendor: "google", domain: "r800-test.in",
  seats: 10, used: 0, mrr: 1_500, status: "active", quote_id: "Q-1",
  start_date: "2026-03-29", renewal_date: "2027-03-29", term_months: 12, billing_cycle: "yearly",
  vendor_cost_per_seat_month: 120, vendor_synced_at: null,
} as unknown as Subscription;

const input = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`)!;
const save = () => fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

describe("R-2545: Correct details is ONE save", () => {
  it("yearly → quarterly + a new renewal date: one request carrying the frequency AND the date together", async () => {
    details.mockResolvedValue(undefined);
    render(<EditSubscriptionDialog sub={r800} open onOpenChange={onOpenChange} />);
    fireEvent.change(document.querySelector("#sub_frequency")!, { target: { value: "quarterly" } });
    fireEvent.change(input("sub_renewal"), { target: { value: "2027-03-28" } });
    fireEvent.change(document.querySelector("#sub_correct_reason")!, { target: { value: "Customer pays quarterly" } });
    save();
    await vi.waitFor(() => expect(details).toHaveBeenCalledTimes(1));
    const arg = details.mock.calls[0][0];
    expect(arg).toMatchObject({
      id: "sub-r800", reason: "Customer pays quarterly",
      commitment: { termMonths: 12, billingCycle: "quarterly", renewalDate: "2027-03-28" },
      patch: { renewal_date: "2027-03-28", start_date: "2026-03-29", domain: "r800-test.in", vendor: "google" },
    });
    expect(arg.data).toBeUndefined();     // no seats / MRR fix
    expect(arg.plan).toBeUndefined();     // plan unchanged
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("refused (renewal too early): the dialog stays open and keeps what was typed", async () => {
    details.mockRejectedValue(new Error("The renewal date 31 Dec 2026 is too early."));
    render(<EditSubscriptionDialog sub={r800} open onOpenChange={onOpenChange} />);
    fireEvent.change(document.querySelector("#sub_frequency")!, { target: { value: "quarterly" } });
    fireEvent.change(input("sub_renewal"), { target: { value: "2026-12-31" } });
    fireEvent.change(document.querySelector("#sub_correct_reason")!, { target: { value: "Customer pays quarterly" } });
    save();
    await vi.waitFor(() => expect(details).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect((document.querySelector("#sub_frequency") as HTMLSelectElement).value).toBe("quarterly");
    expect(input("sub_renewal").value).toBe("2026-12-31");
    expect((document.querySelector("#sub_correct_reason") as HTMLTextAreaElement).value).toBe("Customer pays quarterly");
  });

  it("frequency only (renewal untouched): the commitment step keeps the recorded date (null = keep)", async () => {
    details.mockResolvedValue(undefined);
    render(<EditSubscriptionDialog sub={r800} open onOpenChange={onOpenChange} />);
    fireEvent.change(document.querySelector("#sub_frequency")!, { target: { value: "half_yearly" } });
    fireEvent.change(document.querySelector("#sub_correct_reason")!, { target: { value: "Customer pays in halves" } });
    save();
    await vi.waitFor(() => expect(details).toHaveBeenCalledTimes(1));
    expect(details.mock.calls[0][0].commitment).toEqual({ termMonths: 12, billingCycle: "half_yearly", renewalDate: null });
  });

  it("start AND renewal corrected with the frequency: the frequency goes on the recorded date (null), the new dates in the last step", async () => {
    details.mockResolvedValue(undefined);
    render(<EditSubscriptionDialog sub={r800} open onOpenChange={onOpenChange} />);
    fireEvent.change(document.querySelector("#sub_frequency")!, { target: { value: "quarterly" } });
    fireEvent.change(input("sub_start"), { target: { value: "2025-03-29" } });   // renewal follows: 29 Mar 2026
    fireEvent.change(document.querySelector("#sub_correct_reason")!, { target: { value: "Year typed wrong; pays quarterly" } });
    save();
    await vi.waitFor(() => expect(details).toHaveBeenCalledTimes(1));
    const arg = details.mock.calls[0][0];
    expect(arg.commitment).toEqual({ termMonths: 12, billingCycle: "quarterly", renewalDate: null });
    expect(arg.patch).toMatchObject({ start_date: "2025-03-29", renewal_date: "2026-03-29" });
  });

  it("dates / domain only: one request with no data, plan or commitment part", async () => {
    details.mockResolvedValue(undefined);
    render(<EditSubscriptionDialog sub={r800} open onOpenChange={onOpenChange} />);
    fireEvent.change(input("sub_domain"), { target: { value: "r800-fixed.in" } });
    save();
    await vi.waitFor(() => expect(details).toHaveBeenCalledTimes(1));
    const arg = details.mock.calls[0][0];
    expect(arg.data).toBeUndefined();
    expect(arg.plan).toBeUndefined();
    expect(arg.commitment).toBeUndefined();
    expect(arg.patch.domain).toBe("r800-fixed.in");
  });
});

describe("R-2545: correctDetailsArgs — what reaches correct_subscription_details", () => {
  it("an omitted part is sent as nulls, so the SQL skips that step", () => {
    expect(correctDetailsArgs({
      id: "s1", reason: "x",
      patch: { vendor: "google", domain: null, start_date: "2026-03-29", renewal_date: null, payment_due_date: null },
    })).toEqual({
      p_subscription_id: "s1", p_reason: "x", p_vendor: "google", p_domain: null,
      p_start_date: "2026-03-29", p_renewal_date: null, p_payment_due_date: null,
      p_data_seats: null, p_data_mrr: null, p_item_id: null, p_seats: null, p_mrr: null,
      p_term_months: null, p_billing_cycle: null, p_commitment_renewal: null,
    });
  });

  it("every part filled maps onto its own arguments", () => {
    expect(correctDetailsArgs({
      id: "s1", reason: "Wrong seat count on the record",
      data: { seats: 12, mrr: 1800 },
      plan: { itemId: "gws-std", seats: 12, mrr: 1800 },
      commitment: { termMonths: 12, billingCycle: "quarterly", renewalDate: "2027-03-28" },
      patch: { vendor: "google", domain: "a.in", start_date: "2026-03-29", renewal_date: "2027-03-28", payment_due_date: "2026-12-15" },
    })).toMatchObject({
      p_data_seats: 12, p_data_mrr: 1800, p_item_id: "gws-std", p_seats: 12, p_mrr: 1800,
      p_term_months: 12, p_billing_cycle: "quarterly", p_commitment_renewal: "2027-03-28",
      p_renewal_date: "2027-03-28", p_payment_due_date: "2026-12-15", p_domain: "a.in",
    });
  });
});
