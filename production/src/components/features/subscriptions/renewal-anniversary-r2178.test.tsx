// @vitest-environment jsdom
//
// R-2178 (3) — one renewal-date rule (coordinator decision 31 Oct, Pardeep delegated): renewal_date
// = the NEXT term's start = start + term months (the anniversary — Zoho's next period start). The
// sale form and record_payment already wrote that; Correct details (start-date edit, commitment
// change) and Add subscription wrote start + term − 1 day. Staging: Venus got 31 Jul 2027 from
// 1 Aug 2026 (want 1 Aug 2027).
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EditSubscriptionDialog } from "./edit-subscription-dialog";
import { AddSubscriptionDialog } from "./add-subscription-dialog";
import type { Subscription } from "@/lib/supabase/database.types";

vi.mock("@/lib/queries/subscriptions", () => ({
  useUpdateSubscription: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCorrectSubscriptionTerms: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCorrectSubscriptionCommitment: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useScheduleInvoices: () => ({ data: undefined }),
}));
vi.mock("@/lib/queries/items", () => ({ useItems: () => ({ data: [], isLoading: false }) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: { id: "u1", tenantId: "t1", role: "owner" } }),
}));
vi.mock("./suspend-subscription-dialog", () => ({
  MIN_SUSPEND_REASON: 3,
  useSuspendSubscription: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/dates/ist", async (orig) => ({
  ...(await orig<typeof import("@/lib/dates/ist")>()),
  istToday: () => "2026-10-31",
}));

const writes: Array<{ table: string; row: Record<string, unknown> }> = [];
function chainOf(rows: unknown[]) {
  const settled = Promise.resolve({ data: rows, error: null });
  const chain: Record<string, unknown> = {
    select: () => chain, eq: () => chain, or: () => chain, ilike: () => chain, order: () => chain, limit: () => chain,
    then: (...a: unknown[]) => (settled.then as (...x: unknown[]) => unknown)(...a),
  };
  return chain;
}
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: async () => ({ data: "Q-T-0001", error: null }),
    from: (table: string) => ({
      ...chainOf([]),
      insert: async (row: Record<string, unknown>) => { writes.push({ table, row }); return { error: null }; },
      upsert: async (row: Record<string, unknown>) => { writes.push({ table, row }); return { error: null }; },
      update: () => ({ eq: async () => ({ error: null }) }),
      delete: () => ({ eq: async () => ({ error: null }) }),
    }),
  }),
}));

afterEach(() => { cleanup(); writes.length = 0; });

const sub = (over: Partial<Subscription> = {}): Subscription => ({
  id: "sub-1", tenant_id: "t1", customer_id: "c1", customer_name: "Venus Infotech",
  plan: "Google Workspace Business Standard", vendor: "google", seats: 10, used: 0, mrr: 3000, status: "active",
  start_date: "2026-08-01", renewal_date: "2027-08-01", term_months: 12, billing_cycle: "monthly",
  ...over,
} as unknown as Subscription);
const field = (id: string) => document.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)!;

describe("R-2178 Correct details writes the anniversary", () => {
  it("start corrected to 3 Aug 2026 on an annual sub → renews 3 Aug 2027 (Zoho's next period start)", () => {
    render(<EditSubscriptionDialog sub={sub()} open onOpenChange={() => {}} />);
    fireEvent.change(field("sub_start"), { target: { value: "2026-08-03" } });
    expect(field("sub_renewal").value).toBe("2027-08-03");
  });
  it("an old inclusive row (1 Apr 2026 → 31 Mar 2027) is still read as 12 months and written as the anniversary", () => {
    render(<EditSubscriptionDialog sub={sub({ start_date: "2026-04-01", renewal_date: "2027-03-31" })} open onOpenChange={() => {}} />);
    fireEvent.change(field("sub_start"), { target: { value: "2026-05-01" } });
    expect(field("sub_renewal").value).toBe("2027-05-01");
  });
  it("Venus: Flexible from 1 Aug 2026 → Annual commitment renews 1 Aug 2027", () => {
    render(<EditSubscriptionDialog sub={sub({ renewal_date: "2026-11-01", term_months: 1 })} open onOpenChange={() => {}} />);
    fireEvent.change(field("sub_commitment"), { target: { value: "12" } });
    expect(field("sub_renewal").value).toBe("2027-08-01");
  });
});

describe("R-2178 Add subscription writes the anniversary", () => {
  function openAdd() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AddSubscriptionDialog open onOpenChange={() => {}} onNeedsPayment={() => {}} />
      </QueryClientProvider>,
    );
  }
  it("start 3 Aug 2026 → Renews on 3 Aug 2027; the field says the term ends 2 Aug 2027", () => {
    openAdd();
    fireEvent.change(field("startDate"), { target: { value: "2026-08-03" } });
    expect(field("renewalDate").value).toBe("2027-08-03");
    expect(document.body.textContent).toContain("Term ends 2 Aug 2027");
  });
  it("Opening: billed outside this app until the LAST covered day, so the renewal bills here", async () => {
    openAdd();
    const set = (id: string, value: string) => fireEvent.change(field(id), { target: { value } });
    set("custName", "Zeus Traders"); set("subDomain", "zeus.in"); set("contactName", "Ravi");
    set("contactEmail", "ravi@zeus.in"); set("contactPhone", "+91 98765 43210"); set("newCustState", "07");
    set("pricePerSeat", "1000"); set("seats", "40"); set("startDate", "2026-04-01");
    expect(field("renewalDate").value).toBe("2027-04-01");
    fireEvent.click(Array.from(document.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("Opening — already billed & paid"))!);
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(writes.map((w) => w.table)).toContain("subscriptions"));
    const row = writes.find((w) => w.table === "subscriptions")!.row;
    expect(row).toMatchObject({ renewal_date: "2027-04-01", billed_externally_until: "2027-03-31" });
  });
});
