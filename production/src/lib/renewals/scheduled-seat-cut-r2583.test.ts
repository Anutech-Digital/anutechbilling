/**
 * R-2583 — a seat cut scheduled "At end of term" (R-2252) is billed at renewal: the renewal quote
 * is made for the cut seats at the same per-seat rate. Edge cases 1–8 on the card.
 */
import { describe, it, expect, vi } from "vitest";
import { createOrGetRenewalQuote, type CreateRenewalQuoteInput } from "./create-renewal-quote";
import { renewalSeatCut, type ScheduledSeatCutRow } from "./scheduled-seat-cut";
import { istToday } from "@/lib/dates/ist";

interface Quote { amount: number; subtotal: number; seats: number; line_items: Array<{ qty: number; rate: number; cost: number }>; notes: string }

function fakeDb(cuts: ScheduledSeatCutRow[] | { error: string }, linked?: Record<string, unknown>) {
  const quotes: Quote[] = [];
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    Object.assign(chain, {
      select: self, eq: self,
      then: (ok: (v: unknown) => unknown) => ok(
        table === "subscription_seat_reductions"
          ? ("error" in cuts ? { data: null, error: { message: cuts.error } } : { data: cuts, error: null })
          : { data: [], error: null },
      ),
      maybeSingle: async () => ({
        data: table === "customers" ? { country: "India" } : table === "items" ? { msrp: 300, wholesale: 110 } : null,
        error: null,
      }),
      single: async () => ({ data: table === "quotes" ? linked ?? null : null, error: null }),
    });
    return chain;
  };
  const rpc = vi.fn(async (fn: string, args: { p_quote: Quote }) => {
    if (fn !== "create_renewal_quote") return { data: null, error: { message: `unexpected rpc ${fn}` } };
    quotes.push(args.p_quote);
    const p = args.p_quote;
    return { data: { quote_id: "Q-1", created: true, amount: p.amount, subtotal: p.subtotal, discount_pct: 0, tax_rate: 18, line_items: p.line_items }, error: null };
  });
  return { db: { from, rpc } as unknown as CreateRenewalQuoteInput["supabase"], quotes, rpc };
}

const renewalDate = "2099-04-01";
const row = (over: Partial<ScheduledSeatCutRow> = {}): ScheduledSeatCutRow => ({
  id: "cut-1", timing: "end_of_term", status: "scheduled", seats_before: 10, seats_after: 7, effective_date: renewalDate, ...over,
});
const input = (db: CreateRenewalQuoteInput["supabase"], over: Partial<CreateRenewalQuoteInput> = {}): CreateRenewalQuoteInput => ({
  supabase: db, subscriptionId: "sub-1", tenantId: "ten-1", customerId: "cust-1", customerName: "Acme",
  plan: "Workspace Starter", itemId: "item-1", seats: 10, mrr: 3000, termMonths: 12,
  renewalDate, graceDays: 7, ...over,
});

describe("R-2583: renewal quote bills the scheduled end-of-term seat cut", () => {
  it("1. cut 10 → 7 for this renewal → quote for 7 seats, rate × qty = subtotal, GST on top", async () => {
    const { db, quotes } = fakeDb([row()]);
    const r = await createOrGetRenewalQuote(input(db));
    // ₹3,000/mo for 10 seats = ₹3,600 per seat a year; 7 × 3,600 = 25,200 + 18% = 29,736
    expect(quotes[0]).toMatchObject({ seats: 7, subtotal: 25200, amount: 29736 });
    expect(quotes[0].line_items[0]).toMatchObject({ qty: 7, rate: 3600, cost: 110 * 12 });
    expect(quotes[0].notes).toMatch(/Seats 10 → 7/);
    expect(r).toMatchObject({ amount: 29736, subtotal: 25200 });
  });

  it("2. per-seat rate stays the full subscription's — also on the exact sold term amount (R-2369)", async () => {
    const { db, quotes } = fakeDb([row()]);
    await createOrGetRenewalQuote(input(db, { termAmount: 36010 }));   // 3,601 per seat
    expect(quotes[0].line_items[0]).toMatchObject({ qty: 7, rate: 3601 });
    expect(quotes[0].subtotal).toBe(3601 * 7);
  });

  it("no scheduled cut → quote for the current seats, as before", async () => {
    const { db, quotes } = fakeDb([]);
    await createOrGetRenewalQuote(input(db));
    expect(quotes[0]).toMatchObject({ seats: 10, subtotal: 36000, amount: 42480 });
  });

  it("3. a past-dated row is never applied (R-2584)", () => {
    expect(renewalSeatCut([row({ effective_date: "2020-01-01" })], { seats: 10, renewalDate: "2020-01-01" }, istToday()))
      .toEqual({ kind: "none" });
  });

  it("4. a row for another term's date is not applied", async () => {
    const { db, quotes } = fakeDb([row({ effective_date: "2099-03-31" })]);
    await createOrGetRenewalQuote(input(db));
    expect(quotes[0].seats).toBe(10);
  });

  it("5. only scheduled end-of-term rows count", () => {
    const sub = { seats: 10, renewalDate };
    for (const r of [row({ status: "cancelled" }), row({ status: "applied" }), row({ timing: "now", status: "done" })]) {
      expect(renewalSeatCut([r], sub, "2099-01-01")).toEqual({ kind: "none" });
    }
    expect(renewalSeatCut([row(), row({ id: "cut-2" })], sub, "2099-01-01")).toEqual({ kind: "none" });
  });

  it("6. seats changed since scheduling (Add seats 10 → 12) → not applied, the quote says why", async () => {
    const { db, quotes } = fakeDb([row()]);
    await createOrGetRenewalQuote(input(db, { seats: 12, mrr: 3600 }));
    expect(quotes[0].seats).toBe(12);
    expect(quotes[0].notes).toMatch(/seat cut 10 → 7 was scheduled .* now has 12 seats/);
  });

  it("7. a linked quote comes back unchanged — never re-priced, never a second quote", async () => {
    const linked = { id: "Q-OLD", amount: 42480, subtotal: 36000, discount_pct: 0, tax_rate: 18, line_items: [{ qty: 10 }] };
    const { db, rpc } = fakeDb([row()], linked);
    const r = await createOrGetRenewalQuote(input(db, { existingQuoteId: "Q-OLD" }));
    expect(r).toMatchObject({ quoteId: "Q-OLD", amount: 42480, created: false });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("the cut could not be read → no quote (one at the old seats would over-bill)", async () => {
    const { db, rpc } = fakeDb({ error: "boom" });
    const r = await createOrGetRenewalQuote(input(db));
    expect(r).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
});
