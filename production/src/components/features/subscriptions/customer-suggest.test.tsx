// @vitest-environment jsdom
//
// R-1443 — Onboard dialog: typing a company that exists offers it; picking it reuses it; a
// subscription the customer already has (same domain + plan) is shown BEFORE submit with a
// link to it, and submit writes nothing.
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
const subRows = [{ id: "s1", customer_id: "c1", domain: "acme.in", plan: "Google Workspace Standard", item_id: "GW-STD", status: "active" }];

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

describe("R-1443 Onboard dialog — existing customer + duplicate subscription", () => {
  it("typing 'acme' offers Acme Traders; picking it fills the domain and hides the contact block", async () => {
    mount();
    fireEvent.change(field("custName"), { target: { value: "acme" } });
    const pick = await screen.findByRole("button", { name: /Acme Traders/ });
    fireEvent.click(pick);
    expect(field("custName").value).toBe("Acme Traders");
    expect(field("subDomain").value).toBe("acme.in");
    expect(document.querySelector("#contactName")).toBeNull();
  });

  it("the same plan on the same domain is flagged with 'Open existing subscription', and submit writes nothing", async () => {
    mount();
    fireEvent.change(field("custName"), { target: { value: "acme" } });
    fireEvent.click(await screen.findByRole("button", { name: /Acme Traders/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/already has Google Workspace Standard on acme\.in/);
    expect(screen.getByRole("button", { name: "Open existing subscription" })).toBeTruthy();

    fireEvent.change(field("paymentDueDate"), { target: { value: "2026-11-30" } });
    fireEvent.submit(field("custName").closest("form")!);
    await waitFor(() => expect(toastErrors).toContain("This subscription already exists — nothing was created"));
    expect(writes).toEqual([]);
  });
});
