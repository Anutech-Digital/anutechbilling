// @vitest-environment jsdom
//
// R-2097 — "Opening — already billed & paid before using this app".
// Staging reconcile, 29 Oct 2026: customers whose base plan was billed in Zoho / paid on Razorpay
// before go-live could only be added as Postpaid (a false balance due) or Payment received (the
// money a second time). The third choice files the subscription — seats, rate, term dates — with
// NO quote, NO invoice, NO payment and NOTHING due, marked as billed outside this app until its
// renewal date (R-1763's external_source / billed_externally_until, so the billing cron and the
// database never invoice this term; the renewal bills here as usual).
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AddSubscriptionDialog } from "./add-subscription-dialog";
import { subscriptionDue } from "@/lib/accounting/receivables-due";

vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: { id: "u1", tenantId: "t1", role: "owner" } }),
}));
vi.mock("@/lib/queries/items", () => ({ useItems: () => ({ data: [], isLoading: false }) }));

const writes: Array<{ table: string; op: string; row: Record<string, unknown> }> = [];
const rpcs: string[] = [];

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
    rpc: async (fn: string) => { rpcs.push(fn); return { data: "Q-T-0001", error: null }; },
    from: (table: string) => ({
      ...chainOf([]),
      insert: async (row: Record<string, unknown>) => { writes.push({ table, op: "insert", row }); return { error: null }; },
      upsert: async (row: Record<string, unknown>) => { writes.push({ table, op: "upsert", row }); return { error: null }; },
      update: () => ({ eq: async () => ({ error: null }) }),
      delete: () => ({ eq: async () => ({ error: null }) }),
    }),
  }),
}));

afterEach(() => { cleanup(); writes.length = 0; rpcs.length = 0; });

function fillOpening() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AddSubscriptionDialog open onOpenChange={() => {}} onNeedsPayment={() => {}} />
    </QueryClientProvider>,
  );
  const set = (id: string, value: string) =>
    fireEvent.change(document.querySelector<HTMLInputElement>(`#${id}`)!, { target: { value } });
  set("custName", "Zeus Traders");
  set("subDomain", "zeus.in");
  set("contactName", "Ravi");
  set("contactEmail", "ravi@zeus.in");
  set("contactPhone", "+91 98765 43210");
  set("newCustState", "07");
  set("pricePerSeat", "1000");
  set("seats", "40");
  set("startDate", "2026-04-01");
  set("renewalDate", "2027-04-01");   // R-2178: the anniversary
  const btn = Array.from(document.querySelectorAll("button"))
    .find((b) => (b.textContent ?? "").includes("Opening — already billed & paid"));
  expect(btn, "the Opening choice is on the form").toBeTruthy();
  fireEvent.click(btn!);
  /* No payment due date is asked for: nothing is owed. */
  expect(document.querySelector("#paymentDueDate")).toBeNull();
  fireEvent.submit(document.querySelector("form")!);
}

describe("R-2097 Add Subscription → Opening (billed & paid before this app)", () => {
  it("files the subscription with nothing due, no quote, no invoice, no payment", async () => {
    fillOpening();
    await waitFor(() => expect(writes.map((w) => w.table)).toContain("subscriptions"));
    const tables = writes.map((w) => w.table);
    expect(tables).not.toContain("quotes");
    expect(tables).not.toContain("invoices");
    expect(tables).not.toContain("payments");
    expect(rpcs).not.toContain("next_document_number");   // no quote number minted
    const sub = writes.find((w) => w.table === "subscriptions")!.row;
    expect(sub).toMatchObject({
      seats: 40,
      start_date: "2026-04-01",
      renewal_date: "2027-04-01",
      status: "active",
      outstanding_amount: 0,
      payment_due_date: null,
      external_source: "opening",
      billed_externally_until: "2027-03-31",   // R-2178: the last covered day (renewal − 1)
      billing_cycle: "yearly",
      term_months: 12,
    });
    expect(sub.quote_id ?? null).toBeNull();
    /* Dues / aging / collections read this: nothing to chase. */
    expect(subscriptionDue({ customer_id: "c1", outstanding_amount: sub.outstanding_amount as number })).toBe(0);
    /* MRR counts it: 40 × ₹1,000 / 12 (subscriptions.mrr is whole rupees — see R-2095). */
    expect(sub.mrr).toBe(3333);
  });
});
