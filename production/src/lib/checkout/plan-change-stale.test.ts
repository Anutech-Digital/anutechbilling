/**
 * R-2596: a stale plan-change quote is refused at the online pay start — before a Razorpay order
 * exists — by the same rules record_payment uses (R-2589 / R-2227), so the customer is never
 * charged for money the webhook would then refuse to book.
 */
import { describe, expect, it, vi } from "vitest";
import { planChangeStaleReason, type PlanChangeSubNow } from "./plan-change-stale";
import { startQuotePayment, type QuoteForOrder } from "./quote-order";

const SUB: PlanChangeSubNow = { id: "sub-1", status: "active", seats: 10, mrr: 1000, plan: "Starter" };
const line = (pc: Record<string, unknown>) => [{ description: "Plan change", plan_change: pc }];
const PC = { subscription_id: "sub-1", from_seats: 10, from_mrr: 1000, from_plan: "Starter", to_plan: "Business", seats: 10, new_mrr: 1500 };

describe("planChangeStaleReason — the SQL's rules", () => {
  it("still matches → null", () => {
    expect(planChangeStaleReason(line(PC), SUB)).toBeNull();
  });
  it("not a plan-change line → null", () => {
    expect(planChangeStaleReason([{ description: "Renewal" }], SUB)).toBeNull();
    expect(planChangeStaleReason(null, SUB)).toBeNull();
  });
  it("seats cut since the quote (Reduce seats) → changed", () => {
    expect(planChangeStaleReason(line(PC), { ...SUB, seats: 7, mrr: 700 })).toBe("changed");
  });
  it("₹/month corrected (Correct details) → changed", () => {
    expect(planChangeStaleReason(line(PC), { ...SUB, mrr: 1100 })).toBe("changed");
  });
  it("plan changed → changed; from_plan not stored → plan not compared", () => {
    expect(planChangeStaleReason(line(PC), { ...SUB, plan: "Plus" })).toBe("changed");
    const { from_plan: _p, ...noPlan } = PC;
    expect(planChangeStaleReason(line(noPlan), { ...SUB, plan: "Plus" })).toBeNull();
  });
  it("from_plan blank vs no plan → same (trim + empty = none)", () => {
    expect(planChangeStaleReason(line({ ...PC, from_plan: "  " }), { ...SUB, plan: null })).toBeNull();
  });
  it("a quote made before R-2589 (no from_seats / from_mrr) → changed", () => {
    expect(planChangeStaleReason(line({ subscription_id: "sub-1" }), SUB)).toBe("changed");
  });
  it("no subscription links the quote → link_lost; another subscription → other_subscription", () => {
    expect(planChangeStaleReason(line(PC), null)).toBe("link_lost");
    expect(planChangeStaleReason(line(PC), { ...SUB, id: "sub-2" })).toBe("other_subscription");
  });
  it("R-2227 bad line: fewer seats than the subscription, or ₹0/month → bad_line", () => {
    expect(planChangeStaleReason(line({ ...PC, seats: 8 }), SUB)).toBe("bad_line");
    expect(planChangeStaleReason(line({ ...PC, new_mrr: 0 }), SUB)).toBe("bad_line");
  });
  it("subscription not active → not_active", () => {
    expect(planChangeStaleReason(line(PC), { ...SUB, status: "cancelled" })).toBe("not_active");
  });
});

/* startQuotePayment with an admin client that knows one subscription row. */
function admin(
  sub: (PlanChangeSubNow & { renewal_quote_id: string; tenant_id: string }) | null,
  readError = false,
  /* R-2626: rows the later-parts reader sees (subscription_billings / invoices / quotes). */
  later: { tables?: Record<string, Record<string, unknown>[]>; failOn?: string } = {},
) {
  const from = vi.fn((table: string) => {
    const filters: [string, unknown][] = [];
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => { filters.push([c, v]); return q; },
      gt: (c: string, v: unknown) => { filters.push([`gt:${c}`, v]); return q; },
      in: () => q,
      order: () => q,
      limit: () => q,
      then: (ok: (r: unknown) => unknown, err?: (e: unknown) => unknown) => {
        if (!["subscription_billings", "invoices", "quotes"].includes(table)) return Promise.reject(new Error(`unexpected table ${table}`)).then(ok, err);
        if (later.failOn === table) return Promise.resolve({ data: null, error: { message: "boom" } }).then(ok, err);
        const rows = (later.tables?.[table] ?? []).filter((r) => filters.every(([c, v]) =>
          c.startsWith("gt:") ? String(r[c.slice(3)]) > String(v) : r[c] === v));
        return Promise.resolve({ data: rows, error: null }).then(ok, err);
      },
      maybeSingle: async () => {
        if (table !== "subscriptions") throw new Error(`unexpected table ${table}`);
        if (readError) return { data: null, error: { message: "boom" } };
        const hit = sub && filters.every(([c, v]) => (sub as unknown as Record<string, unknown>)[c] === v);
        return { data: hit ? sub : null, error: null };
      },
    };
    return q;
  });
  return { client: { from } as never, from };
}

const QUOTE: QuoteForOrder = {
  id: "Q-PC-1", status: "sent", payment_status: "awaiting", expires_date: null, amount: 1180, currency: "INR",
  customer_name: "SCN Plan Change Co", tenant_id: "t-1", invoice_id: null, billing_cycle: "yearly",
  subtotal: 1000, discount_pct: 0, tax_rate: 18, line_items: line(PC), superseded_by: null, extension_months: 0,
};
const OPTS = { allowSimulation: false, logTag: "[test]" };

describe("startQuotePayment — R-2596 stale plan-change quote", () => {
  it("seats cut since the quote → 409 with a clear message; no payments read, no order", async () => {
    const a = admin({ ...SUB, seats: 7, mrr: 700, renewal_quote_id: "Q-PC-1", tenant_id: "t-1" });
    const r = await startQuotePayment(a.client, QUOTE, OPTS);
    expect(r.status).toBe(409);
    expect(String(r.body.error)).toMatch(/plan-change quote is out of date/i);
    expect(String(r.body.nextStep)).toMatch(/new quote/i);
    expect(r.body.planChangeStale).toBe("changed");
    expect(a.from.mock.calls.map((c) => c[0])).toEqual(["subscriptions"]);
  });

  it("quote no longer linked → 409 link_lost", async () => {
    const r = await startQuotePayment(admin(null).client, QUOTE, OPTS);
    expect(r.status).toBe(409);
    expect(r.body.planChangeStale).toBe("link_lost");
  });

  it("subscription read fails → 500 retry, no order", async () => {
    const r = await startQuotePayment(admin(null, true).client, QUOTE, OPTS);
    expect(r.status).toBe(500);
    expect(String(r.body.error)).toMatch(/retry/i);
  });

  it("a plan-change quote that still matches goes on to the normal checks (payments ledger read)", async () => {
    const a = admin({ ...SUB, renewal_quote_id: "Q-PC-1", tenant_id: "t-1" });
    // The ledger read is the next step; the mock refuses any table but subscriptions → caught → 500.
    const r = await startQuotePayment(a.client, QUOTE, OPTS).catch((e: Error) => ({ status: -1, body: { error: e.message } }));
    /* R-2626: the later-parts read (no billing rows here) comes between. */
    expect(a.from.mock.calls.map((c) => c[0]).slice(0, 3)).toEqual(["subscriptions", "subscription_billings", "payments"]);
    expect((r.body as Record<string, unknown>).planChangeStale).toBeUndefined();
  });

  it("an ordinary quote (no plan_change line) never reads subscriptions", async () => {
    const a = admin(null);
    await startQuotePayment(a.client, { ...QUOTE, extension_months: null, line_items: [{ description: "Workspace" }] }, OPTS)
      .catch(() => undefined);
    expect(a.from.mock.calls.map((c) => c[0])).not.toContain("subscriptions");
  });
});

describe("R-2617 — scheduled end-of-term seat cut refuses the pay start", () => {
  const cut = { status: "scheduled", timing: "end_of_term", effective_date: "2027-04-01" };
  const withCuts = (rows: PlanChangeSubNow["subscription_seat_reductions"]): PlanChangeSubNow =>
    ({ ...SUB, renewal_date: "2027-04-01", subscription_seat_reductions: rows });

  it("cut dated this renewal → seat_cut_scheduled", () => {
    expect(planChangeStaleReason(line(PC), withCuts([cut]))).toBe("seat_cut_scheduled");
  });
  it.each([
    ["earlier term (R-2584)", { ...cut, effective_date: "2026-04-01" }],
    ["cancelled", { ...cut, status: "cancelled" }],
    ["applied", { ...cut, status: "applied" }],
    ["now cut", { ...cut, timing: "now", status: "done" }],
  ])("%s → still payable", (_n, row) => {
    expect(planChangeStaleReason(line(PC), withCuts([row]))).toBeNull();
  });

  it("startQuotePayment → 409 with its own message, no order", async () => {
    const a = admin({ ...withCuts([cut]), renewal_quote_id: "Q-PC-1", tenant_id: "t-1" });
    const r = await startQuotePayment(a.client, QUOTE, OPTS);
    expect(r.status).toBe(409);
    expect(r.body.planChangeStale).toBe("seat_cut_scheduled");
    expect(String(r.body.error)).toMatch(/seat reduction is scheduled/);
    expect(String(r.body.nextStep)).toMatch(/Nothing has been charged/);
    expect(a.from.mock.calls.map((c) => c[0])).toEqual(["subscriptions"]);
  });
});

describe("R-2626 — a later part already billed refuses the pay start", () => {
  const PC_Q2 = { ...PC, period_from: "2026-08-16", period_to: "2026-09-30" };
  const quote = { ...QUOTE, line_items: line(PC_Q2) };
  const linked = { ...SUB, renewal_quote_id: "Q-PC-1", tenant_id: "t-1" };
  const billing = (n: number, start: string, invoice_id: string | null = null) =>
    ({ id: `B${n}`, tenant_id: "t-1", subscription_id: "sub-1", period_index: n, period_start: start, period_end: "2027-01-01", invoice_id });

  it("Q3 has an open proforma → 409 later_part_billed before any payments read / order", async () => {
    const a = admin(linked, false, { tables: {
      subscription_billings: [billing(3, "2026-10-01")],
      quotes: [{ id: "PI-3", tenant_id: "t-1", subscription_billing_id: "B3", status: "sent" }],
    } });
    const r = await startQuotePayment(a.client, quote, OPTS);
    expect(r.status).toBe(409);
    expect(r.body.planChangeStale).toBe("later_part_billed");
    expect(String(r.body.error)).toMatch(/already billed at the old plan's rate/);
    expect(String(r.body.nextStep)).toMatch(/Nothing has been charged/);
    expect(a.from.mock.calls.map((c) => c[0])).not.toContain("payments");
  });

  it("Q3 invoiced (live) → 409; parts only up to the quote's period_to (Q2) → goes on", async () => {
    const inv = admin(linked, false, { tables: {
      subscription_billings: [billing(3, "2026-10-01", "INV-3")],
      invoices: [{ id: "INV-3", tenant_id: "t-1", status: "paid" }],
    } });
    expect((await startQuotePayment(inv.client, quote, OPTS)).status).toBe(409);

    const cur = admin(linked, false, { tables: {
      subscription_billings: [billing(2, "2026-07-01", "INV-2")],
      invoices: [{ id: "INV-2", tenant_id: "t-1", status: "paid" }],
    } });
    await startQuotePayment(cur.client, quote, OPTS).catch(() => undefined);
    expect(cur.from.mock.calls.map((c) => c[0])).toContain("payments");
  });

  it("billing parts read fails → 500 retry, no order", async () => {
    const a = admin(linked, false, { failOn: "subscription_billings" });
    const r = await startQuotePayment(a.client, quote, OPTS);
    expect(r.status).toBe(500);
    expect(String(r.body.error)).toMatch(/retry/i);
    expect(a.from.mock.calls.map((c) => c[0])).not.toContain("payments");
  });
});
