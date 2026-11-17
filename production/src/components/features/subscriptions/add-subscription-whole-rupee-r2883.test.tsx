// @vitest-environment jsdom
//
// R-2883 (Pardeep's decision, 17 Nov): the Onboard / Add Subscription price box takes WHOLE RUPEES only.
// A price with paise (799.50 x 3 seats = 2398.5) used to fail Payment Received and Postpaid at save
// ("invalid input syntax for type integer") because quotes.subtotal / quotes.amount are INTEGER. The
// box now refuses it BEFORE save, on every path, with one plain message; nothing is rounded silently.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AddSubscriptionDialog } from "./add-subscription-dialog";

vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: { id: "u1", tenantId: "t1", role: "owner" } }),
}));

/* A catalogue row whose price carries paise: the box is prefilled with it and must show the message. */
const WORKSPACE_ITEM = {
  id: "gws-std", name: "Google Workspace Business Standard", vendor: "google", kind: "main", item_type: "subscription",
  is_active: true, msrp: 300, wholesale: 264,
  prices: { annual: { msrp: 300, wholesale: 264 }, monthly: { msrp: 360, wholesale: 318 } },
};
const PAISE_ITEM = {
  id: "paise-1", name: "Paise Plan", vendor: "google", kind: "main", item_type: "subscription",
  is_active: true, msrp: 799.55, wholesale: 600,
  prices: { annual: { msrp: 799.55, wholesale: 600 }, monthly: { msrp: 99.5, wholesale: 80 } },
};
let catalog: unknown[] = [WORKSPACE_ITEM];
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

afterEach(() => { cleanup(); writes.length = 0; catalog = [WORKSPACE_ITEM]; });

const MESSAGE = "Enter a whole-rupee price";
const $ = <T extends Element = HTMLInputElement>(sel: string) => document.querySelector<T>(sel);
const set = (id: string, value: string) => fireEvent.change($(`#${id}`)!, { target: { value } });
const clickText = (text: string) => {
  const btn = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(text));
  expect(btn, `button "${text}"`).toBeTruthy();
  fireEvent.click(btn!);
};
const saveButton = () => Array.from(document.querySelectorAll("button"))
  .find((b) => (b.textContent ?? "").includes("Activate Subscription"))! as HTMLButtonElement;
const message = () => $("[data-testid='price-whole-rupee']");

async function fill(price: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><AddSubscriptionDialog open onOpenChange={() => {}} onNeedsPayment={() => {}} /></QueryClientProvider>);
  await waitFor(() => expect($("#pricePerSeat")).not.toBeNull());
  set("custName", "Zeus Traders");
  set("subDomain", "zeus.in");
  set("contactName", "Ravi");
  set("contactEmail", "ravi@zeus.in");
  set("contactPhone", "+91 98765 43210");
  set("newCustState", "07");
  set("seats", "3");
  set("pricePerSeat", price);
  set("startDate", "2025-04-01");
}

describe("R-2883 Onboard dialog — whole-rupee price only", () => {
  it("a price with paise shows the message under the box and disables Save", async () => {
    await fill("799.5");
    expect(message()?.textContent).toBe(MESSAGE);
    expect(saveButton().disabled).toBe(true);
  });

  it("Postpaid: paise price -> no save call at all", async () => {
    await fill("799.5");
    set("paymentDueDate", "2025-05-01");
    fireEvent.submit($("form")!);
    await new Promise((r) => setTimeout(r, 50));
    expect(writes).toEqual([]);
  });

  it("Payment Received: paise price -> no save call at all", async () => {
    await fill("799.5");
    clickText("Payment Received (Paid)");
    fireEvent.submit($("form")!);
    await new Promise((r) => setTimeout(r, 50));
    expect(writes).toEqual([]);
  });

  it("Opening: paise price -> no save call at all, so the N-year amounts can no longer differ", async () => {
    await fill("799.5");
    clickText("Opening — already billed & paid");
    expect(message()?.textContent).toBe(MESSAGE);
    expect(saveButton().disabled).toBe(true);
    fireEvent.submit($("form")!);
    await new Promise((r) => setTimeout(r, 50));
    expect(writes).toEqual([]);
  });

  it("a whole-rupee price (also typed as 800.00) shows no message and saves; the subtotal is an integer", async () => {
    await fill("800.00");
    expect(message()).toBeNull();
    expect(saveButton().disabled).toBe(false);
    set("paymentDueDate", "2025-05-01");
    fireEvent.submit($("form")!);
    await waitFor(() => expect(writes.map((w) => w.table)).toContain("subscriptions"));
    const quote = writes.find((w) => w.table === "quotes")!.row;
    expect(Number.isInteger(quote.subtotal)).toBe(true);
    expect(Number.isInteger(quote.amount)).toBe(true);
    expect(quote.subtotal).toBe(2400);
  });

  it("correcting the price to whole rupees clears the message and re-enables Save", async () => {
    await fill("799.5");
    expect(saveButton().disabled).toBe(true);
    set("pricePerSeat", "800");
    expect(message()).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it("a catalogue price with paise is NOT rounded: the box keeps it and shows the message", async () => {
    catalog = [PAISE_ITEM];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><AddSubscriptionDialog open onOpenChange={() => {}} onNeedsPayment={() => {}} /></QueryClientProvider>);
    await waitFor(() => expect(Number.isInteger(Number($("#pricePerSeat")!.value))).toBe(false));
    expect(message()?.textContent).toBe(MESSAGE);
    expect(saveButton().disabled).toBe(true);
  });
});
