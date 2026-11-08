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
function admin(sub: (PlanChangeSubNow & { renewal_quote_id: string; tenant_id: string }) | null, readError = false) {
  const from = vi.fn((table: string) => {
    const filters: [string, unknown][] = [];
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => { filters.push([c, v]); return q; },
      limit: () => q,
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
    expect(a.from.mock.calls.map((c) => c[0]).slice(0, 2)).toEqual(["subscriptions", "payments"]);
    expect((r.body as Record<string, unknown>).planChangeStale).toBeUndefined();
  });

  it("an ordinary quote (no plan_change line) never reads subscriptions", async () => {
    const a = admin(null);
    await startQuotePayment(a.client, { ...QUOTE, extension_months: null, line_items: [{ description: "Workspace" }] }, OPTS)
      .catch(() => undefined);
    expect(a.from.mock.calls.map((c) => c[0])).not.toContain("subscriptions");
  });
});
