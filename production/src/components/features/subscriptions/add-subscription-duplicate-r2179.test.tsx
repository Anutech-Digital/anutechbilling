// @vitest-environment jsdom
//
// R-2179 (August reconcile) — Opening subscription for a product + domain the customer already has:
// the old row has no domain of its own (= the customer's domain). The warning shows BEFORE submit
// with its seats and renewal date and the way on; submit writes nothing.
import { describe, it, expect, afterEach, vi } from "vitest";
import * as React from "react";
import { render, cleanup, fireEvent, waitFor, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AddSubscriptionDialog } from "./add-subscription-dialog";

vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: { id: "u1", tenantId: "t1", role: "owner" } }),
}));
/* One catalogue row: the dialog seeds it as the plan (item GW-STD). */
const catalogRows = [{
  id: "GW-STD", name: "Google Workspace Standard", vendor: "google", msrp: 864, wholesale: 620,
  prices: { annual: { msrp: 864, wholesale: 620 } }, item_type: "subscription", is_active: true,
}];
vi.mock("@/lib/queries/items", () => ({ useItems: () => ({ data: catalogRows, isLoading: false }) }));

const writes: string[] = [];
const toastErrors: string[] = [];
vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: (m: string) => { toastErrors.push(m); } } }));
const customerRows = [{ id: "c1", name: "Acme Traders", domain: "acme.in" }];
const subRows = [{ id: "s1", customer_id: "c1", domain: null, plan: "Google Workspace Standard", item_id: "GW-STD", status: "active", seats: 12, renewal_date: "2027-03-31" }];

function chainOf(rows: unknown[]) {
  const settled = Promise.resolve({ data: rows, error: null });
  const chain: Record<string, unknown> = {
    select: () => chain, eq: () => chain, or: () => chain, ilike: () => chain,
    order: () => chain, limit: () => chain,
    then: (...a: unknown[]) => (settled.then as (...x: unknown[]) => unknown)(...a),
  };
  return chain;
}

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: async () => ({ data: "Q-1", error: null }),
    from: (table: string) => ({
      ...chainOf(table === "customers" ? customerRows : table === "subscriptions" ? subRows : []),
      insert: async () => { writes.push(table); return { error: null }; },
      upsert: async () => { writes.push(table); return { error: null }; },
      delete: () => ({ eq: async () => ({ error: null }) }),
    }),
  }),
}));

afterEach(() => { cleanup(); writes.length = 0; toastErrors.length = 0; });

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AddSubscriptionDialog open onOpenChange={() => {}} onSuccess={() => {}} />
    </QueryClientProvider>,
  );
}
const field = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`)!;

describe("R-2179 Opening subscription — duplicate on the customer's own domain", () => {
  it("warns with product, domain, seats, renewal date and the way on; submit writes nothing", async () => {
    mount();
    fireEvent.change(field("custName"), { target: { value: "acme" } });
    fireEvent.click(await screen.findByRole("button", { name: /Acme Traders/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "This customer already has Google Workspace Standard on acme.in (12 seats, renews 31 Mar 2027) — use Manage seats or Correct details instead.",
    );
    expect(screen.getByRole("button", { name: "Open existing subscription" })).toBeTruthy();

    fireEvent.change(field("paymentDueDate"), { target: { value: "2026-11-30" } });
    fireEvent.submit(field("custName").closest("form")!);
    await waitFor(() => expect(toastErrors).toContain("This subscription already exists — nothing was created"));
    expect(writes).toEqual([]);
  });
});
