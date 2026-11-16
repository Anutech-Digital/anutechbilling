/**
 * R-2849 — priceRenewalQuote is THE renewal pricing: createOrGetRenewalQuote (cron / Send now / Review) stores exactly
 * the p_quote it returns, and Bill together for yearly subscriptions sends the same object per subscription to
 * create_renewal_quote_together — no second copy. A price that cannot be worked out says why (ok: false).
 */
import { describe, it, expect, vi } from "vitest";
import { createOrGetRenewalQuote, priceRenewalQuote, type CreateRenewalQuoteInput } from "./create-renewal-quote";

type Row = Record<string, unknown>;
const GW_STD: Row = { id: "E2E-GW-STD", name: "Google Workspace Business Standard", vendor: "google", msrp: 90, wholesale: 62, prices: {}, is_active: true };

function fakeDb(opts: { cuts?: Row[]; cutError?: boolean; country?: string } = {}) {
  const from = (table: string) => {
    const filters: [string, unknown][] = [];
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      limit: () => chain,
      eq: (c: string, v: unknown) => { filters.push([c, v]); return chain; },
      maybeSingle: async () => {
        if (table === "customers") return { data: { country: opts.country ?? "India" }, error: null };
        if (table === "items") {
          const hit = [GW_STD].filter((r) => filters.every(([c, v]) => c === "tenant_id" || r[c] === v));
          return { data: hit.length === 1 ? hit[0] : null, error: null };
        }
        return { data: null, error: null };
      },
      then: (ok: (v: unknown) => unknown) => {
        if (table === "subscription_seat_reductions") return ok(opts.cutError ? { data: null, error: { message: "boom" } } : { data: opts.cuts ?? [], error: null });
        if (table === "items") return ok({ data: [GW_STD], error: null });
        return ok({ data: [], error: null });
      },
    });
    return chain;
  };
  const rpc = vi.fn(async (_fn: string, args: { p_quote: Record<string, unknown> }) => ({
    data: { quote_id: "Q-NEW", created: true, amount: args.p_quote.amount, subtotal: args.p_quote.subtotal, discount_pct: 0, tax_rate: 18, line_items: args.p_quote.line_items },
    error: null,
  }));
  return { db: { from, rpc } as unknown as CreateRenewalQuoteInput["supabase"], rpc };
}

/* ITBUZZ's Business Standard: 20 seats at ₹90 a seat a month, renews 31 Oct 2026 (yearly). */
const input = (db: CreateRenewalQuoteInput["supabase"], over: Partial<CreateRenewalQuoteInput> = {}): CreateRenewalQuoteInput => ({
  supabase: db, subscriptionId: "sub-std", tenantId: "ten-1", customerId: "cust-1", customerName: "ITBUZZ Technologies",
  plan: "Google Workspace Business Standard", itemId: "E2E-GW-STD", seats: 20, mrr: 1800, termMonths: 12,
  renewalDate: "2026-10-31", graceDays: 7, existingQuoteId: null, ...over,
});

describe("R-2849 priceRenewalQuote — the one renewal pricing", () => {
  it("R-2849 shared builder: createOrGetRenewalQuote stores exactly priceRenewalQuote's p_quote (no second copy)", async () => {
    const a = fakeDb();
    const priced = await priceRenewalQuote(input(a.db));
    const b = fakeDb();
    await createOrGetRenewalQuote(input(b.db));
    expect(priced.ok).toBe(true);
    if (!priced.ok) return;
    const stored = b.rpc.mock.calls[0][1].p_quote;
    /* created_date is today's IST date in both — the same object otherwise */
    expect(stored).toEqual(priced.pQuote);
    expect(priced).toMatchObject({ seats: 20, perSeatRate: 1080, subtotal: 21600, taxRate: 18, amount: 25488, termMonths: 12 });
    expect(priced.pQuote).toMatchObject({ seats: 20, subtotal: 21600, amount: 25488, tax_rate: 18, extension_months: 12 });
    expect((priced.pQuote.line_items as Row[])[0]).toMatchObject({ qty: 20, rate: 1080, item_id: "E2E-GW-STD" });
  });

  it("R-2849 seat cut: a cut scheduled for this renewal date prices the cut seats at the full per-seat rate", async () => {
    const { db } = fakeDb({ cuts: [{ id: "c1", timing: "end_of_term", status: "scheduled", seats_before: 20, seats_after: 15, effective_date: "2026-10-31" }] });
    const priced = await priceRenewalQuote(input(db));
    expect(priced).toMatchObject({ ok: true, seats: 15, perSeatRate: 1080, subtotal: 16200 });
  });

  it("R-2849 export customer: 0% GST, amount = subtotal", async () => {
    const { db } = fakeDb({ country: "United States" });
    const priced = await priceRenewalQuote(input(db));
    expect(priced).toMatchObject({ ok: true, taxRate: 0, subtotal: 21600, amount: 21600 });
  });

  it("R-2849 priceRenewalQuote null: seat cuts unreadable → ok:false with the reason, and createOrGetRenewalQuote makes nothing", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = fakeDb({ cutError: true });
    expect(await priceRenewalQuote(input(a.db))).toEqual({ ok: false, reason: "its scheduled seat cuts could not be read" });
    const b = fakeDb({ cutError: true });
    expect(await createOrGetRenewalQuote(input(b.db))).toBeNull();
    expect(b.rpc).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("R-2849 priceRenewalQuote null: a stored price far off the catalogue (144x) → ok:false (renewalTerm's reason), no quote", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, rpc } = fakeDb();
    const priced = await priceRenewalQuote(input(db, { mrr: 1800 * 144 }));
    expect(priced.ok).toBe(false);
    expect(await createOrGetRenewalQuote(input(db, { mrr: 1800 * 144 }))).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
