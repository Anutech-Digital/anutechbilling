/**
 * R-2849 — fillRenewalLines (the DB half for yearly subscriptions): reads each one's linked renewal quote with the
 * signed-in client (live = open, or closed with money received — r2847_quote_live's rule), prices only the ones that can
 * join with priceRenewalQuote through the admin client, and turns a price it cannot work out into plain words.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TogetherReadFact } from "./bill-together.server";

const priced = vi.hoisted(() => ({ calls: [] as Array<{ id: string; client: string; graceDays: number }>, fail: new Set<string>() }));
vi.mock("./create-renewal-quote", () => ({
  priceRenewalQuote: async (i: { subscriptionId: string; supabase: { __kind: string }; graceDays: number; seats: number }) => {
    priced.calls.push({ id: i.subscriptionId, client: i.supabase.__kind, graceDays: i.graceDays });
    if (priced.fail.has(i.subscriptionId)) return { ok: false, reason: "subscription x: stored mrr is 144x the catalogue price" };
    return { ok: true, pQuote: { subtotal: i.seats * 1080 }, lineItems: [], seats: i.seats, perSeatRate: 1080, subtotal: i.seats * 1080,
      amount: Math.round(i.seats * 1080 * 1.18), taxRate: 18, termMonths: 12 };
  },
}));

import { fillRenewalLines } from "./bill-together-renewal.server";

const T = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function fact(id: string, o: Record<string, unknown> = {}): TogetherReadFact {
  const sub = { id, tenant_id: T, customer_id: "c1", customer_name: "ITBUZZ", plan: id === A ? "Business Standard" : "Business Starter",
    billing_cycle: "yearly", status: "active", auto_renew: true, renewal_quote_id: null, seats: id === A ? 20 : 10, mrr: 1800, term_months: 12,
    term_amount: null, start_date: "2025-10-31", renewal_date: "2026-10-31", billed_externally_until: null, quote_id: null, ...o };
  return { id, sub: sub as never, row: sub as never, next: null, togetherBills: [] };
}

function fakeDb(kind: string, tables: Record<string, unknown[]>) {
  return {
    __kind: kind,
    from: (t: string) => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain, eq: () => chain, in: () => chain, is: () => chain,
        maybeSingle: async () => ({ data: (tables[t] ?? [])[0] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown) => ok({ data: tables[t] ?? [], error: null }),
      });
      return chain;
    },
  } as unknown as SupabaseClient;
}

beforeEach(() => { priced.calls = []; priced.fail = new Set(); });

describe("R-2849 fillRenewalLines", () => {
  it("prices each joinable yearly sub with the admin client and the company's grace days; line = its own period, seats × rate", async () => {
    const db = fakeDb("cookie", {});
    const admin = fakeDb("admin", { tenants: [{ grace_period_days: 7 }] });
    const out = await fillRenewalLines(db, admin, T, [fact(A), fact(B, { start_date: "2024-11-01" })], new Date("2026-10-20T06:00:00Z"));
    expect(priced.calls).toEqual([{ id: A, client: "admin", graceDays: 7 }, { id: B, client: "admin", graceDays: 7 }]);
    expect(out[0].renewal?.line).toEqual({ seats: 20, seatRate: 1080, periodStart: "2026-10-31", periodEnd: "2027-10-30", taxable: 21600, taxRate: 18, tax: 3888, gross: 25488 });
    /* B: an imported row (renewal date = its term's last day) → its next year starts the day after */
    expect(out[1].renewal?.line).toMatchObject({ periodStart: "2026-11-01", periodEnd: "2027-10-31" });
    expect(out[0].renewalQuote).toEqual({ subtotal: 21600 });
  });

  it("a renewal quote closed WITH money received still holds the sub (live), and it is not priced; a closed one with no money is free", async () => {
    const db = fakeDb("cookie", {
      quotes: [
        { id: "Q-PAID", status: "expired", cancelled_at: null, superseded_by: null, payment_status: "partial" },
        { id: "Q-DEAD", status: "rejected", cancelled_at: "2026-10-01", superseded_by: null, payment_status: "awaiting" },
      ],
      renewal_quote_subscriptions: [],
    });
    const admin = fakeDb("admin", { tenants: [{ grace_period_days: 0 }] });
    const out = await fillRenewalLines(db, admin, T, [fact(A, { renewal_quote_id: "Q-PAID" }), fact(B, { renewal_quote_id: "Q-DEAD" })]);
    expect(out[0].renewal?.linked).toMatchObject({ quoteId: "Q-PAID", live: true });
    expect(out[1].renewal?.linked).toMatchObject({ quoteId: "Q-DEAD", live: false });
    expect(priced.calls.map((c) => c.id)).toEqual([B]);
  });

  it("a live together quote: its members (and their plans) come from the link rows", async () => {
    const db = fakeDb("cookie", {
      quotes: [{ id: "Q-T", status: "sent", cancelled_at: null, superseded_by: null, payment_status: "awaiting" }],
      renewal_quote_subscriptions: [{ quote_id: "Q-T", subscription_id: A }, { quote_id: "Q-T", subscription_id: B }],
    });
    const out = await fillRenewalLines(db, fakeDb("admin", {}), T, [fact(A, { renewal_quote_id: "Q-T" }), fact(B, { renewal_quote_id: "Q-T" })]);
    expect(out[0].renewal?.linked).toEqual({ quoteId: "Q-T", live: true, subscriptionIds: [A, B], withPlans: ["Business Starter"] });
    expect(priced.calls).toEqual([]);
  });

  it("a price that cannot be worked out → plain words (the 144x log text never reaches the screen); split / Won't renew rows untouched", async () => {
    priced.fail.add(A);
    const out = await fillRenewalLines(fakeDb("cookie", {}), fakeDb("admin", {}), T,
      [fact(A), fact(B, { billing_cycle: "monthly" }), fact("cccccccc-cccc-4ccc-8ccc-cccccccccccc", { auto_renew: false })]);
    expect(out[0].renewal).toMatchObject({ line: null, priceError: "its stored price does not match its plan's catalogue price" });
    expect(out[0].renewalQuote).toBeNull();
    expect(out[1].renewal).toBeUndefined();
    expect(out[2].renewal).toBeUndefined();
  });

  it("already renewed for this term → settled words, not priced", async () => {
    const out = await fillRenewalLines(fakeDb("cookie", {}), fakeDb("admin", {}), T,
      [fact(A, { renewal_state: "renewed", renewal_date: "2027-10-31" })], new Date("2026-11-20T06:00:00Z"));
    expect(out[0].renewal?.settled).toMatch(/^Already renewed — the next term's renewal quote opens 30 days before 2027-10-31\.$/);
    expect(priced.calls).toEqual([]);
  });
});
