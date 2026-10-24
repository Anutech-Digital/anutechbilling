/**
 * R-1574 — a renewal quote is made AND linked to its subscription in ONE database call.
 *
 * Before: next_document_number → insert into quotes → update subscriptions.renewal_quote_id,
 * three separate calls with no lock and an unchecked link. Two overlapping runs (cron +
 * "Generate renewal quote", or a retry) each made a quote; the later link overwrote the
 * earlier, and paying the earlier one opened a NEW subscription while the real one was never
 * renewed (reproduced on local Docker; supabase/tests/r1574_renewal_quote_once.test.sql pins
 * the database side). Here: the helper hands the priced quote to create_renewal_quote and
 * returns whatever quote that call says belongs to the term — never one of its own making.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createOrGetRenewalQuote, type CreateRenewalQuoteInput } from "./create-renewal-quote";

interface MadeArgs { p_subscription_id: string; p_tenant_id: string; p_quote: Record<string, unknown> }

function fakeDb(made?: { data: unknown; error: { message: string } | null }) {
  const calls = { rpc: [] as Array<{ fn: string; args: MadeArgs }>, inserts: [] as unknown[], updates: [] as unknown[] };
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    Object.assign(chain, {
      select: self, eq: self,
      maybeSingle: async () => ({
        data: table === "customers" ? { country: "India" } : table === "items" ? { msrp: 300, wholesale: 110 } : null,
        error: null,
      }),
      insert: async (row: unknown) => { calls.inserts.push(row); return { error: null }; },
      update: (row: unknown) => { calls.updates.push(row); return chain; },
    });
    return chain;
  };
  const rpc = vi.fn(async (fn: string, args: MadeArgs) => {
    calls.rpc.push({ fn, args });
    if (fn !== "create_renewal_quote") return { data: null, error: { message: `unexpected rpc ${fn}` } };
    if (made) return made;
    const p = args.p_quote;
    return {
      data: { quote_id: "Q-T-27-0001", created: true, relinked: false, amount: p.amount, subtotal: p.subtotal,
              discount_pct: 0, tax_rate: p.tax_rate, line_items: p.line_items },
      error: null,
    };
  });
  return { db: { from, rpc } as unknown as CreateRenewalQuoteInput["supabase"], calls };
}

const input = (db: CreateRenewalQuoteInput["supabase"]): CreateRenewalQuoteInput => ({
  supabase: db, subscriptionId: "sub-1", tenantId: "ten-1", customerId: "cust-1", customerName: "Acme",
  plan: "Workspace Starter", itemId: "item-1", seats: 2, mrr: 600, termMonths: 12,
  renewalDate: "2026-11-01", graceDays: 7,
});

describe("R-1574: the shared renewal quote goes through create_renewal_quote", () => {
  it("one RPC call carries the subscription, the company and the priced quote", async () => {
    const { db, calls } = fakeDb();
    const r = await createOrGetRenewalQuote(input(db));
    expect(calls.rpc.map((c) => c.fn)).toEqual(["create_renewal_quote"]);
    const { args } = calls.rpc[0];
    expect(args).toMatchObject({ p_subscription_id: "sub-1", p_tenant_id: "ten-1" });
    // 2 seats × ₹3,600/yr = ₹7,200 + 18% GST = ₹8,496, for the subscription's own 12 months
    expect(args.p_quote).toMatchObject({ amount: 8496, subtotal: 7200, tax_rate: 18, extension_months: 12, seats: 2 });
    expect(r).toMatchObject({ quoteId: "Q-T-27-0001", amount: 8496, subtotal: 7200, created: true });
  });

  it("never numbers, inserts or links on its own — that was the race", async () => {
    const { db, calls } = fakeDb();
    await createOrGetRenewalQuote(input(db));
    expect(calls.rpc.map((c) => c.fn)).not.toContain("next_document_number");
    expect(calls.inserts).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
  });

  it("another run made this term's quote first → THAT quote comes back (created false)", async () => {
    const theirs = { quote_id: "Q-T-27-0000", created: false, relinked: true, amount: 9000, subtotal: 7627, discount_pct: 0, tax_rate: 18, line_items: [] };
    const { db } = fakeDb({ data: theirs, error: null });
    const r = await createOrGetRenewalQuote(input(db));
    expect(r).toMatchObject({ quoteId: "Q-T-27-0000", amount: 9000, subtotal: 7627, created: false });
  });

  it("the RPC refuses → null and the reason is logged (one transaction: nothing half-made)", async () => {
    const { db } = fakeDb({ data: null, error: { message: "Subscription sub-1 belongs to another company" } });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await createOrGetRenewalQuote(input(db));
    expect(r).toBeNull();
    expect(err.mock.calls.flat().join(" ")).toContain("belongs to another company");
    err.mockRestore();
  });
});

describe("R-1574: no renewal-quote path links a subscription by a separate update", () => {
  /* Comments stripped so prose about the old code cannot satisfy or trip the scan. */
  const strip = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const file of ["src/lib/renewals/create-renewal-quote.ts", "src/lib/domains/renewal.ts"]) {
    it(`${file} uses create_renewal_quote and writes neither quotes nor renewal_quote_id itself`, () => {
      const code = strip(file);
      expect(code).toContain('rpc("create_renewal_quote"');
      expect(code).not.toContain('rpc("next_document_number"');
      expect(code).not.toMatch(/from\("quotes"\)\s*\.insert/);
      expect(code).not.toMatch(/renewal_quote_id:\s*\w/);
    });
  }
});
