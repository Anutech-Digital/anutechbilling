/**
 * R-2736 — createOrGetRenewalQuote takes the line COST from the catalogue (by item_id, exact name, or the
 * one confident match) and keeps the PRICE = the subscription's agreed rate. Q-F588-27-0156 (localhost
 * 14 Nov): no item_id, catalogue row "E2E Google Workspace Business Standard" → cost was 0.
 */
import { describe, it, expect, vi } from "vitest";
import { createOrGetRenewalQuote, type CreateRenewalQuoteInput } from "./create-renewal-quote";

type Row = Record<string, unknown>;
const GW_STD: Row = { id: "E2E-GW-STD", name: "E2E Google Workspace Business Standard", vendor: "google", msrp: 736, wholesale: 620, prices: {}, is_active: true };
const GW_STR: Row = { id: "E2E-GW-STR", name: "E2E Google Workspace Business Starter", vendor: "google", msrp: 136, wholesale: 110, prices: {}, is_active: true };

function fakeDb(catalog: Row[], opts: { listError?: boolean } = {}) {
  const itemReads: [string, unknown][][] = [];
  const from = (table: string) => {
    const filters: [string, unknown][] = [];
    if (table === "items") itemReads.push(filters);
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      limit: () => chain,
      eq: (c: string, v: unknown) => { filters.push([c, v]); return chain; },
      maybeSingle: async () => {
        if (table === "customers") return { data: { country: "India" }, error: null };
        if (table === "items") {
          const id = filters.find(([c]) => c === "id")?.[1];
          const name = filters.find(([c]) => c === "name")?.[1];
          const hit = catalog.filter((r) => (id !== undefined ? r.id === id : r.name === name));
          return { data: hit.length === 1 ? hit[0] : null, error: null };
        }
        return { data: null, error: null };
      },
      single: async () => ({ data: null, error: null }),
      then: (ok: (v: unknown) => unknown) => {
        if (table === "items") return ok(opts.listError ? { data: null, error: { message: "boom" } } : { data: catalog, error: null });
        return ok({ data: [], error: null });
      },
    });
    return chain;
  };
  const rpc = vi.fn(async (_fn: string, args: { p_quote: Record<string, unknown> }) => ({
    data: { quote_id: "Q-NEW", created: true, amount: args.p_quote.amount, subtotal: args.p_quote.subtotal, discount_pct: 0, tax_rate: 18, line_items: args.p_quote.line_items },
    error: null,
  }));
  return { db: { from, rpc } as unknown as CreateRenewalQuoteInput["supabase"], rpc, itemReads };
}

/* SCN Kochi's subscription as on localhost: 20 seats, mrr ₹1,800, annual, no item_id. */
const input = (db: CreateRenewalQuoteInput["supabase"], over: Partial<CreateRenewalQuoteInput> = {}): CreateRenewalQuoteInput => ({
  supabase: db, subscriptionId: "sub-1", tenantId: "ten-1", customerId: "cust-1", customerName: "SCN Kochi",
  plan: "Google Workspace Business Standard", itemId: null, seats: 20, mrr: 1800, termMonths: 12,
  renewalDate: "2099-04-01", graceDays: 7, existingQuoteId: null, ...over,
});

const quoteOf = (rpc: ReturnType<typeof fakeDb>["rpc"]) => rpc.mock.calls[0][1].p_quote as { line_items: Row[]; total_cost: number; subtotal: number };

describe("R-2736 renewal line cost from the catalogue", () => {
  it("r2736 confident match: no item_id + non-exact name → cost ₹7,440/seat, item_id set, total_cost known", async () => {
    const { db, rpc } = fakeDb([GW_STR, GW_STD]);
    await createOrGetRenewalQuote(input(db));
    const q = quoteOf(rpc);
    expect(q.line_items[0]).toMatchObject({ cost: 7440, item_id: "E2E-GW-STD", qty: 20 });
    expect(q.total_cost).toBe(7440 * 20);
  });

  it("r2736 price stays the agreed rate: rate = mrr × 12 ÷ seats (₹1,080), not the catalogue ₹736×12", async () => {
    const { db, rpc } = fakeDb([GW_STD]);
    await createOrGetRenewalQuote(input(db));
    const q = quoteOf(rpc);
    expect(q.line_items[0].rate).toBe(1080);
    expect(q.subtotal).toBe(21600);
  });

  it("item_id still wins (and is the line's item_id)", async () => {
    const { db, rpc } = fakeDb([GW_STR, GW_STD]);
    await createOrGetRenewalQuote(input(db, { itemId: "E2E-GW-STR", plan: "Business Starter", mrr: 2000 }));
    expect(quoteOf(rpc).line_items[0]).toMatchObject({ cost: 1320, item_id: "E2E-GW-STR" });
  });

  it("r2736 ambiguous no guess: only another tier in the catalogue → cost 0 (unknown), no item_id", async () => {
    const { db, rpc } = fakeDb([GW_STR]);
    await createOrGetRenewalQuote(input(db));
    const q = quoteOf(rpc);
    expect(q.line_items[0].cost).toBe(0);
    expect(q.line_items[0].item_id).toBeUndefined();
    expect(q.total_cost).toBe(0);
  });

  it("a catalogue that cannot be read → cost unknown, the quote still made", async () => {
    const { db, rpc } = fakeDb([GW_STD], { listError: true });
    await createOrGetRenewalQuote(input(db));
    expect(quoteOf(rpc).line_items[0].cost).toBe(0);
  });

  it("r2736 multi-year: a 24-month term costs two years", async () => {
    const { db, rpc } = fakeDb([GW_STD]);
    await createOrGetRenewalQuote(input(db, { termMonths: 24, termAmount: 43200 }));
    expect(quoteOf(rpc).line_items[0]).toMatchObject({ cost: 14880, years: 2 });
  });

  it("every items read is tenant-scoped", async () => {
    const { db, itemReads } = fakeDb([GW_STD]);
    await createOrGetRenewalQuote(input(db));
    expect(itemReads.length).toBeGreaterThan(0);
    for (const f of itemReads) expect(f).toContainEqual(["tenant_id", "ten-1"]);
  });
});
