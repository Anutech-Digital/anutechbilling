// @vitest-environment jsdom
//
// R-2734 (Pratik, 16 Oct): "domain registration ka agar client ne 3 saal ki payment ki hai toh 1 yr se
// zyada ka option hi nahi raha, aur na hi date select ka". The Onboard / Add Subscription dialog now
// offers "Register for 1-10 years" on a DOMAIN plan (Annual · Yearly). The price box stays per year
// (as R-2712's Bulk dialog); the quote is the whole term billed once; the subscription renews
// start + N years at the yearly price — on every path (Postpaid, Payment Received, Opening).
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AddSubscriptionDialog } from "./add-subscription-dialog";

vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: { id: "u1", tenantId: "t1", role: "owner" } }),
}));

const DOMAIN_ITEM = {
  id: "dom-in", name: "Domain .in", vendor: "domain", kind: "main", item_type: "subscription",
  is_active: true, msrp: 0, wholesale: 0,
  prices: { annual_total: { msrp: 800, wholesale: 600 } },
};
const WORKSPACE_ITEM = {
  id: "gws-std", name: "Google Workspace Business Standard", vendor: "google", kind: "main", item_type: "subscription",
  is_active: true, msrp: 300, wholesale: 264,
  prices: { annual: { msrp: 300, wholesale: 264 }, monthly: { msrp: 360, wholesale: 318 } },
};
let catalog: unknown[] = [DOMAIN_ITEM];
vi.mock("@/lib/queries/items", () => ({ useItems: () => ({ data: catalog, isLoading: false }) }));

const writes: Array<{ table: string; op: string; row: Record<string, unknown> }> = [];

function chainOf(rows: unknown[]) {
  const settled = Promise.resolve({ data: rows, error: null });
  const chain: Record<string, unknown> = {
    select: () => chain, eq: () => chain, or: () => chain, ilike: () => chain, order: () => chain, limit: () => chain,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (...a: unknown[]) => (settled.then as (...x: unknown[]) => unknown)(...a),
  };
  return chain;
}

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: async () => ({ data: "Q-T-0001", error: null }),
    from: (table: string) => ({
      ...chainOf([]),
      insert: async (row: Record<string, unknown>) => { writes.push({ table, op: "insert", row }); return { error: null }; },
      upsert: async (row: Record<string, unknown>) => { writes.push({ table, op: "upsert", row }); return { error: null }; },
      update: () => ({ eq: async () => ({ error: null }) }),
      delete: () => ({ eq: async () => ({ error: null }) }),
    }),
  }),
}));

afterEach(() => { cleanup(); writes.length = 0; catalog = [DOMAIN_ITEM]; });

const $ = <T extends Element = HTMLInputElement>(sel: string) => document.querySelector<T>(sel);
const set = (id: string, value: string) => fireEvent.change($(`#${id}`)!, { target: { value } });
const clickText = (text: string) => {
  const btn = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(text));
  expect(btn, `button "${text}"`).toBeTruthy();
  fireEvent.click(btn!);
};

function open(onNeedsPayment: (h: unknown) => void = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AddSubscriptionDialog open onOpenChange={() => {}} onNeedsPayment={onNeedsPayment} />
    </QueryClientProvider>,
  );
}

async function fillDomain3Years() {
  open();
  await waitFor(() => expect($("#regYears")).not.toBeNull());
  set("custName", "Zeus Traders");
  set("subDomain", "zeus.in");
  set("contactName", "Ravi");
  set("contactEmail", "ravi@zeus.in");
  set("contactPhone", "+91 98765 43210");
  set("newCustState", "07");
  set("seats", "1");
  set("pricePerSeat", "800");
  set("startDate", "2025-04-01");
  set("regYears", "3");
}

describe("R-2734 Onboard dialog — domain 'Register for N years'", () => {
  it("shows the picker for a domain plan; Renews on follows start + N years and is locked", async () => {
    await fillDomain3Years();
    const renewal = $("#renewalDate")!;
    expect(renewal.value).toBe("2028-04-01");
    expect(renewal.disabled).toBe(true);
    /* The whole term, billed once, is said before submit. */
    expect(document.body.textContent).toContain("for 3 years");
    /* Back to 1 year: the 1-year date again, editable as before. */
    set("regYears", "1");
    expect($("#renewalDate")!.value).toBe("2026-04-01");
    expect($("#renewalDate")!.disabled).toBe(false);
  });

  it("Postpaid: quote = 3-year total once; subscription renews 2028-04-01 at the yearly mrr", async () => {
    await fillDomain3Years();
    set("paymentDueDate", "2025-05-01");
    fireEvent.submit($("form")!);
    await waitFor(() => expect(writes.map((w) => w.table)).toContain("subscriptions"));
    const quote = writes.find((w) => w.table === "quotes")!.row;
    expect(quote.subtotal).toBe(2400);
    expect(quote.amount).toBe(2832);   // 2400 + 18% GST, once
    const line = (quote.line_items as Array<Record<string, unknown>>)[0];
    expect(line).toMatchObject({ qty: 1, rate: 2400, cost: 1800, years: 3, start_date: "2025-04-01" });
    expect(line.renewal_date).toBeUndefined();
    const sub = writes.find((w) => w.table === "subscriptions")!.row;
    expect(sub).toMatchObject({
      start_date: "2025-04-01", renewal_date: "2028-04-01", term_months: 12, billing_cycle: "yearly",
      mrr: 67,                       // round(800 / 12) — the YEARLY price, never 2400 / 12
      outstanding_amount: 2832,
    });
  });

  it("Opening: billed outside until the last day of the 3 years; yearly mrr", async () => {
    await fillDomain3Years();
    clickText("Opening — already billed & paid");
    fireEvent.submit($("form")!);
    await waitFor(() => expect(writes.map((w) => w.table)).toContain("subscriptions"));
    expect(writes.map((w) => w.table)).not.toContain("quotes");
    const sub = writes.find((w) => w.table === "subscriptions")!.row;
    expect(sub).toMatchObject({
      start_date: "2025-04-01", renewal_date: "2028-04-01", term_months: 12, mrr: 67,
      billed_externally_until: "2028-03-31", outstanding_amount: 0,
    });
  });

  it("Payment Received: the handoff line carries years 3 and the whole term; expected = 3-year total incl. GST", async () => {
    const handoff = vi.fn();
    open(handoff);
    await waitFor(() => expect($("#regYears")).not.toBeNull());
    set("custName", "Zeus Traders");
    set("subDomain", "zeus.in");
    set("contactName", "Ravi");
    set("contactEmail", "ravi@zeus.in");
    set("contactPhone", "+91 98765 43210");
    set("newCustState", "07");
    set("seats", "1");
    set("pricePerSeat", "800");
    set("startDate", "2025-04-01");
    set("regYears", "3");
    clickText("Payment Received");
    fireEvent.submit($("form")!);
    await waitFor(() => expect(handoff).toHaveBeenCalled());
    const h = handoff.mock.calls[0][0] as { expectedAmount: number; lineItems: Array<Record<string, unknown>> };
    expect(h.expectedAmount).toBe(2832);
    expect(h.lineItems[0]).toMatchObject({ rate: 2400, years: 3, start_date: "2025-04-01" });
    expect(h.lineItems[0].renewal_date).toBeUndefined();
    /* record_payment files it — the dialog never inserts a subscription on this path. */
    expect(writes.map((w) => w.table)).not.toContain("subscriptions");
  });

  it("a non-domain plan (Workspace) has no 'Register for' — line and subscription as before", async () => {
    catalog = [WORKSPACE_ITEM];
    open();
    await waitFor(() => expect($<HTMLInputElement>("#pricePerSeat")!.value).not.toBe("0"));
    expect($("#regYears")).toBeNull();
    expect($("#renewalDate")!.disabled).toBe(false);
  });
});
