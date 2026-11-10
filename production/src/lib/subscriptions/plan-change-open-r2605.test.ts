/**
 * R-2605 — an open plan-change quote freezes seats / MRR / plan; a rejected or expired one does not.
 * Add seats (applySeatIncrease, used by Manage seats and seat-request approval) refuses BEFORE any
 * seat quote is made. The SQL side (trigger + reduce_subscription_seats) is
 * supabase/tests/r2605_plan_change_freeze.test.sql.
 */
import { describe, it, expect } from "vitest";
import { isOpenPlanChangeQuote, loadOpenPlanChangeQuoteId, planChangeFreezeMessage } from "./plan-change-open";
import { applySeatIncrease, type SeatIncreaseSubject } from "./apply-seat-increase";

const planChangeLines = [{ name: "Business Standard · change", plan_change: { subscription_id: "S1", seats: 10 } }];

function fakeDb(quote: Record<string, unknown> | null) {
  const tables: string[] = [];
  const db = {
    tables,
    from(table: string) {
      tables.push(table);
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: table === "quotes" ? quote : null, error: null }),
      };
      return chain;
    },
  };
  return db;
}

const sub: SeatIncreaseSubject = {
  id: "S1", tenant_id: "T1", customer_id: "C1", customer_name: "SCN Plan Change Co", plan: "Business Starter",
  vendor: "google", domain: null, seats: 10, mrr: 1500, item_id: null, start_date: "2026-04-01",
  renewal_date: "2027-04-01", status: "active", billing_cycle: "yearly", term_months: 12, quote_id: null,
  renewal_quote_id: "Q-PC-1",
};

describe("R-2605 isOpenPlanChangeQuote", () => {
  it("draft / sent / viewed / accepted plan-change quote is open", () => {
    for (const status of ["draft", "sent", "viewed", "accepted"]) {
      expect(isOpenPlanChangeQuote({ extension_months: 0, line_items: planChangeLines, status })).toBe(true);
    }
  });
  it("rejected (Cancelled) and expired by date are closed — they no longer block", () => {
    expect(isOpenPlanChangeQuote({ extension_months: 0, line_items: planChangeLines, status: "rejected" })).toBe(false);
    expect(isOpenPlanChangeQuote({ extension_months: 0, line_items: planChangeLines, status: "expired", superseded_by: null })).toBe(false);
  });
  it("expired because combined into another quote (superseded_by) still blocks", () => {
    expect(isOpenPlanChangeQuote({ extension_months: 0, line_items: planChangeLines, status: "expired", superseded_by: "Q-COMBINED" })).toBe(true);
  });
  it("a renewal / extension quote is not a plan-change quote", () => {
    expect(isOpenPlanChangeQuote({ extension_months: 12, line_items: planChangeLines, status: "sent" })).toBe(false);
    expect(isOpenPlanChangeQuote({ extension_months: 0, line_items: [{ name: "Support upgrade" }], status: "sent" })).toBe(false);
  });
});

describe("R-2605 loadOpenPlanChangeQuoteId", () => {
  it("no link → null without a read", async () => {
    const db = fakeDb(null);
    expect(await loadOpenPlanChangeQuoteId(db as never, { tenant_id: "T1", renewal_quote_id: null })).toBeNull();
    expect(db.tables).toEqual([]);
  });
  it("linked open plan-change quote → its id; rejected → null", async () => {
    expect(await loadOpenPlanChangeQuoteId(fakeDb({ id: "Q-PC-1", extension_months: 0, line_items: planChangeLines, status: "sent" }) as never, sub)).toBe("Q-PC-1");
    expect(await loadOpenPlanChangeQuoteId(fakeDb({ id: "Q-PC-1", extension_months: 0, line_items: planChangeLines, status: "rejected" }) as never, sub)).toBeNull();
  });
  it("the message names the quote, in the SQL trigger's words", () => {
    expect(planChangeFreezeMessage("Q-PC-1")).toBe("Plan change quote Q-PC-1 is open for this subscription — it was priced on today's seats, monthly amount and plan. Delete that quote (or record its payment) first, then change the seats or details.");
  });
});

describe("R-2605 Add seats with an open plan-change quote", () => {
  it("refused with plan_change_open before tax, quote or seats are touched", async () => {
    const db = fakeDb({ id: "Q-PC-1", extension_months: 0, line_items: planChangeLines, status: "draft" });
    const r = await applySeatIncrease({ supabase: db as never, sub, additionalSeats: 2, graceDays: 7 });
    expect(r).toEqual({ ok: false, code: "plan_change_open", message: planChangeFreezeMessage("Q-PC-1") });
    /* Only the quote read — no customers / tenants / quotes insert / subscriptions update. */
    expect(db.tables).toEqual(["quotes"]);
  });
  it("a cancelled plan-change quote does not block (goes on to price the seats)", async () => {
    const db = fakeDb({ id: "Q-PC-1", extension_months: 0, line_items: planChangeLines, status: "rejected" });
    /* The fake has no write paths, so the call fails LATER — what matters is that it got past the
       plan-change check and went on to price the seats (customers + tenants read for the tax). */
    const r = await applySeatIncrease({ supabase: db as never, sub, additionalSeats: 2, graceDays: 7 }).catch((e: unknown) => e);
    expect(r).not.toMatchObject({ code: "plan_change_open" });
    expect(db.tables.slice(0, 3)).toEqual(["quotes", "customers", "tenants"]);
  });
});
