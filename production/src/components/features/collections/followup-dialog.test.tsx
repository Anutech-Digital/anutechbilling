// @vitest-environment jsdom
/* R-1517 — Follow-up dialog: the "Follow-up with" picker is there only for owner / manager /
   accountant; a sales person sees who it is with and why they cannot change it. A promise asks
   for its date, the next follow-up date is required, history is newest first with the broken
   promise marked, and the body sent never carries created_by. */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react";

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const CUST = "33333333-3333-4333-8333-333333333333";

const st = vi.hoisted(() => ({
  role: "sales",
  history: [] as unknown[],
  mutate: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { userId: ME, role: st.role } }) }));
vi.mock("@/lib/hooks/useUserNames", () => ({
  useUserNames: () => ({
    data: new Map([
      [ME, { id: ME, label: "Me Sales", inactive: false }],
      [OWNER, { id: OWNER, label: "Owner Olga", inactive: false }],
      [OTHER, { id: OTHER, label: "Other Omar", inactive: false }],
    ]),
  }),
}));
vi.mock("@/lib/queries/payment-followups", () => ({
  FollowupSaveError: class extends Error { constructor(m: string, readonly status: number) { super(m); } },
  useCustomerFollowups: () => ({ data: st.history, isLoading: false, isError: false, refetch: vi.fn() }),
  useAddFollowup: () => ({ mutate: st.mutate, isPending: false }),
}));

import { FollowupDialog } from "./followup-dialog";

const renderDialog = () =>
  render(
    <FollowupDialog
      open
      onOpenChange={() => {}}
      customerId={CUST}
      customerName="Acme"
      ownerId={OWNER}
      items={[{ kind: "invoice", id: "INV-A378", label: "INV-A378", quoteId: "Q-1" }]}
      stillOwes
      amountDue={25500}
    />,
  );

beforeEach(() => { st.role = "sales"; st.history = []; st.mutate.mockReset(); });
afterEach(cleanup);

describe("reassign picker", () => {
  it("sales: no picker — shows who it is with and who can change it", () => {
    renderDialog();
    expect(screen.queryByLabelText(/Follow-up with/)).toBeNull();
    expect(screen.getByText("Owner Olga")).toBeTruthy();
    expect(screen.getByText(/Only an owner, manager or accountant can give it to someone else/)).toBeTruthy();
  });

  it.each(["owner", "manager", "accountant"])("%s: picker shown, defaults to the customer's owner", async (role) => {
    st.role = role;
    renderDialog();
    const picker = screen.getByLabelText(/Follow-up with/) as HTMLSelectElement;
    await waitFor(() => expect(picker.value).toBe(OWNER));
  });

  it("sales saving sends no assignedTo and no created_by", async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: "Rang kiya" } });
    fireEvent.click(screen.getByRole("button", { name: /Save follow-up/ }));
    await waitFor(() => expect(st.mutate).toHaveBeenCalledTimes(1));
    const body = st.mutate.mock.calls[0][0];
    expect(body).toMatchObject({ customerId: CUST, kind: "call", note: "Rang kiya", invoiceId: "INV-A378", quoteId: "Q-1" });
    expect(body.assignedTo).toBeUndefined();
    expect(body).not.toHaveProperty("created_by");
  });
});

describe("validation in the form", () => {
  it("a promise without a date is not sent and says why", async () => {
    st.role = "owner";
    renderDialog();
    fireEvent.change(screen.getByLabelText(/What happened/), { target: { value: "promise" } });
    fireEvent.click(screen.getByRole("button", { name: /Save follow-up/ }));
    expect(await screen.findByText(/A promise to pay needs a date/)).toBeTruthy();
    expect(st.mutate).not.toHaveBeenCalled();
  });

  it("an emptied next follow-up date is not sent and says why", async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(/Next follow-up/), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /Save follow-up/ }));
    expect(await screen.findByText(/Pick the next follow-up date/)).toBeTruthy();
    expect(st.mutate).not.toHaveBeenCalled();
  });
});

describe("history", () => {
  it("newest first, a past promise still owed is marked broken", () => {
    const row = (id: string, created_at: string, extra: Record<string, unknown> = {}) => ({
      id, created_at, kind: "call", note: `note ${id}`, promised_amount: null, promised_on: null, next_follow_up_on: "2026-12-01",
      assigned_to: OWNER, created_by: ME, invoice_id: null, quote_id: null, subscription_id: null, ...extra,
    });
    st.history = [
      row("old", "2026-09-01T05:00:00Z", { kind: "promise", promised_amount: 5000, promised_on: "2026-09-10" }),
      row("new", "2026-10-15T05:00:00Z"),
    ];
    renderDialog();
    const items = within(screen.getByRole("list", { name: /Follow-up history/ })).getAllByRole("listitem");
    expect(items.map((li) => li.textContent?.includes("note new") ? "new" : "old")).toEqual(["new", "old"]);
    expect(within(items[1]).getByText("Promise broken")).toBeTruthy();
    expect(within(items[0]).queryByText("Promise broken")).toBeNull();
  });
});

/* R-2404: opened from a Renewals row — about that subscription, its own history (activity log),
   the picker starts on the renewal's owner, and "Customer confirmed the renewal" can be ticked. */
describe("renewal follow-up (R-2404)", () => {
  const SUB = "66666666-6666-4666-8666-666666666666";
  const OTHER_SUB = "77777777-7777-4777-8777-777777777777";
  const hist = (id: string, created_at: string, subscription_id: string | null, assigned_to: string) => ({
    id, created_at, kind: "call", note: `note ${id}`, promised_amount: null, promised_on: null, next_follow_up_on: "2026-12-01",
    assigned_to, created_by: ME, invoice_id: null, quote_id: null, subscription_id,
  });
  const renderRenewal = () =>
    render(
      <FollowupDialog
        open
        onOpenChange={() => {}}
        customerId={CUST}
        customerName="Acme"
        ownerId={OWNER}
        items={[{ kind: "subscription", id: SUB, label: "Workspace · renews 10/11/2026", quoteId: "Q-9" }]}
        stillOwes
        renewal={{ subscriptionId: SUB }}
      />,
    );

  it("history shows only this renewal's entries; the picker starts on the renewal's owner", async () => {
    st.role = "manager";
    st.history = [hist("mine", "2026-10-20T05:00:00Z", SUB, OTHER), hist("theirs", "2026-10-25T05:00:00Z", OTHER_SUB, OWNER)];
    renderRenewal();
    expect(screen.getByText(/Renewal follow-up · Acme/)).toBeTruthy();
    const items = within(screen.getByRole("list", { name: /Follow-up history/ })).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain("note mine");
    const picker = screen.getByLabelText(/Follow-up with/) as HTMLSelectElement;
    await waitFor(() => expect(picker.value).toBe(OTHER));
  });

  it("ticking 'Customer confirmed the renewal' sends the outcome with the subscription", async () => {
    renderRenewal();
    fireEvent.click(screen.getByLabelText(/Customer confirmed the renewal/));
    fireEvent.click(screen.getByRole("button", { name: /Save follow-up/ }));
    await waitFor(() => expect(st.mutate).toHaveBeenCalledTimes(1));
    const body = st.mutate.mock.calls[0][0];
    expect(body).toMatchObject({ customerId: CUST, subscriptionId: SUB, quoteId: "Q-9", outcome: "renewal_confirmed", note: "Customer confirmed the renewal." });
  });

  it("a customer's general follow-up has no 'confirmed' tick", () => {
    renderDialog();
    expect(screen.queryByLabelText(/Customer confirmed the renewal/)).toBeNull();
  });
});

describe("promise / dispute hold (R-2411)", () => {
  const disputeRow = {
    id: "d1", created_at: "2026-11-01T05:00:00Z", kind: "call", note: "Says the rate is wrong", outcome: "disputed",
    promised_amount: null, promised_on: null, next_follow_up_on: "2026-12-01", assigned_to: OWNER, created_by: ME,
    invoice_id: null, quote_id: null, subscription_id: null,
  };

  it("ticking 'Customer disputes the bill' asks for the reason and sends outcome 'disputed'", async () => {
    renderDialog();
    fireEvent.click(screen.getByLabelText(/Customer disputes the bill/));
    fireEvent.click(screen.getByRole("button", { name: /Save follow-up/ }));
    expect(await screen.findByText(/Write why the customer disputes the bill/)).toBeTruthy();
    expect(st.mutate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Why do they dispute it/), { target: { value: "Says the rate is wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /Save follow-up/ }));
    await waitFor(() => expect(st.mutate).toHaveBeenCalledTimes(1));
    expect(st.mutate.mock.calls[0][0]).toMatchObject({ customerId: CUST, outcome: "disputed", note: "Says the rate is wrong" });
  });

  it("an open dispute shows its reason, hides 'Draft a reminder', and 'Mark dispute resolved' logs the resolution", async () => {
    st.history = [disputeRow];
    render(
      <FollowupDialog open onOpenChange={() => {}} customerId={CUST} customerName="Acme" ownerId={OWNER}
        items={[]} stillOwes amountDue={100} onRemind={() => {}} />,
    );
    const banner = screen.getByRole("status", { name: /Disputed/ });
    expect(banner.textContent).toContain("Says the rate is wrong");
    expect(banner.textContent).toMatch(/reminders are paused/i);
    expect(screen.queryByRole("button", { name: /Draft a reminder/ })).toBeNull();
    expect(screen.queryByLabelText(/Customer disputes the bill/)).toBeNull();
    fireEvent.click(within(banner).getByRole("button", { name: /Mark dispute resolved/ }));
    await waitFor(() => expect(st.mutate).toHaveBeenCalledTimes(1));
    expect(st.mutate.mock.calls[0][0]).toMatchObject({ customerId: CUST, kind: "note", outcome: "dispute_resolved" });
  });

  it("a promise says reminders stop until its date", () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(/What happened/), { target: { value: "promise" } });
    expect(screen.getByText(/Automatic payment reminders stop until this date/)).toBeTruthy();
  });

  it("the renewal Follow-up has no dispute tick (R-2404 stays as it was)", () => {
    render(
      <FollowupDialog open onOpenChange={() => {}} customerId={CUST} customerName="Acme" ownerId={OWNER}
        items={[{ kind: "subscription", id: "66666666-6666-4666-8666-666666666666", label: "WS", quoteId: null }]}
        stillOwes renewal={{ subscriptionId: "66666666-6666-4666-8666-666666666666" }} />,
    );
    expect(screen.queryByLabelText(/Customer disputes the bill/)).toBeNull();
    expect(screen.getByLabelText(/Customer confirmed the renewal/)).toBeTruthy();
  });
});
