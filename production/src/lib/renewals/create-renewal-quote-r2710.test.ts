/**
 * R-2710 — the shared renewal quote for "Send renewal": a DRAFT only when asked; the line
 * carries its catalogue item and, on a whole multi-year term, its years (so the editor's
 * "Register for N years" starts right); a draft is gated / marked sent by the reminder senders.
 */
import { describe, it, expect, vi } from "vitest";
import { createOrGetRenewalQuote, draftRenewalQuoteBlock, markRenewalQuoteSent, type CreateRenewalQuoteInput } from "./create-renewal-quote";

interface MadeArgs { p_quote: Record<string, unknown> }

function fakeDb(quoteRow: Record<string, unknown> | null = null) {
  const calls = { rpc: [] as MadeArgs[], updates: [] as Array<{ row: unknown; eqs: Array<[string, unknown]> }> };
  const from = (table: string) => {
    const eqs: Array<[string, unknown]> = [];
    let updating: unknown = null;
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: (k: string, v: unknown) => { eqs.push([k, v]); return chain; },
      maybeSingle: async () => ({
        data: table === "customers" ? { country: "India" } : table === "items" ? { msrp: 300, wholesale: 110 }
            : table === "quotes" ? quoteRow : null,
        error: null,
      }),
      update: (row: unknown) => { updating = row; return chain; },
      then: (res: (v: unknown) => void) => { if (updating) calls.updates.push({ row: updating, eqs }); res({ error: null }); },
    });
    return chain;
  };
  const rpc = vi.fn(async (_fn: string, args: MadeArgs) => {
    calls.rpc.push(args);
    const p = args.p_quote;
    return { data: { quote_id: "Q-T-1", created: true, amount: p.amount, subtotal: p.subtotal, tax_rate: p.tax_rate, line_items: p.line_items }, error: null };
  });
  return { db: { from, rpc } as unknown as CreateRenewalQuoteInput["supabase"], calls };
}

const input = (db: CreateRenewalQuoteInput["supabase"], p: Partial<CreateRenewalQuoteInput> = {}): CreateRenewalQuoteInput => ({
  supabase: db, subscriptionId: "sub-1", tenantId: "ten-1", customerId: "cust-1", customerName: "Acme",
  plan: "Workspace Starter", itemId: "item-1", seats: 2, mrr: 600, termMonths: 12,
  renewalDate: "2026-11-01", graceDays: 7, ...p,
});

describe("R-2710 createOrGetRenewalQuote", () => {
  it("status 'draft' only when asked (Review); the cron / Send now send none (→ 'sent' in the RPC)", async () => {
    const a = fakeDb();
    await createOrGetRenewalQuote(input(a.db, { status: "draft" }));
    expect(a.calls.rpc[0].p_quote.status).toBe("draft");
    const b = fakeDb();
    await createOrGetRenewalQuote(input(b.db));
    expect(b.calls.rpc[0].p_quote).not.toHaveProperty("status");
  });

  it("the line carries the catalogue item; a 12-month term has no years, a 24-month term says 2", async () => {
    const a = fakeDb();
    await createOrGetRenewalQuote(input(a.db));
    const line = (a.calls.rpc[0].p_quote.line_items as Array<Record<string, unknown>>)[0];
    expect(line.item_id).toBe("item-1");
    expect(line).not.toHaveProperty("years");
    const b = fakeDb();
    await createOrGetRenewalQuote(input(b.db, { termMonths: 24 }));
    const p = b.calls.rpc[0].p_quote;
    expect((p.line_items as Array<Record<string, unknown>>)[0].years).toBe(2);
    expect(p.extension_months).toBe(24);
  });
});

describe("R-2710 reminder senders and a draft renewal quote", () => {
  it("a sent quote is never blocked; a draft with no discount passes; a draft waiting for approval is held", async () => {
    expect(await draftRenewalQuoteBlock(fakeDb({ status: "sent", line_items: [] }).db, "ten-1", "Q-1")).toBeNull();
    expect(await draftRenewalQuoteBlock(fakeDb({ status: "draft", line_items: [{ name: "x", qty: 1, rate: 1200, cost: 900, list_rate: 1200 }], approval_status: null }).db, "ten-1", "Q-1")).toBeNull();
    const held = await draftRenewalQuoteBlock(fakeDb({ status: "draft", line_items: [{ name: "x", qty: 1, rate: 100, cost: 900, list_rate: 1200 }], approval_status: null }).db, "ten-1", "Q-1");
    expect(held).toMatch(/^Renewal quote Q-1 is not emailed:/);
  });

  it("an unreadable quote is held (never email on an unknown)", async () => {
    expect(await draftRenewalQuoteBlock(fakeDb(null).db, "ten-1", "Q-1")).toMatch(/could not be read/);
  });

  it("markRenewalQuoteSent moves only a DRAFT of this company to sent", async () => {
    const { db, calls } = fakeDb();
    await markRenewalQuoteSent(db, "ten-1", "Q-1");
    expect(calls.updates).toEqual([{ row: { status: "sent" }, eqs: [["id", "Q-1"], ["tenant_id", "ten-1"], ["status", "draft"]] }]);
  });
});
