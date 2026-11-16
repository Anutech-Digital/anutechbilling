/** R-2710 — a renewal quote emailed from the quote editor moves the subscription's reminder step
 *  (as Send now does), so the nightly cron does not mail the same quote again at that step. */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/renewals/grace-overrides", () => ({
  readGraceOverrides: async () => ({ trustedByCustomer: new Map(), bySubscription: new Map() }),
}));
import { advanceRenewalAfterQuoteEmail } from "./manual-send-step";

const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

function fakeDb(sub: Record<string, unknown> | null) {
  const updates: Array<{ row: Record<string, unknown>; eqs: Array<[string, unknown]> }> = [];
  const from = (table: string) => {
    const eqs: Array<[string, unknown]> = [];
    let row: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: (k: string, v: unknown) => { eqs.push([k, v]); return chain; },
      maybeSingle: async () => ({ data: table === "subscriptions" ? sub : { grace_period_days: 7 }, error: null }),
      update: (r: Record<string, unknown>) => { row = r; return chain; },
      then: (res: (v: unknown) => void) => { if (row) updates.push({ row, eqs }); res({ error: null }); },
    });
    return chain;
  };
  return { db: { from }, updates };
}

const SUB = { id: "s1", customer_id: "c1", renewal_date: iso(18), renewal_state: "pending", term_months: 12, reminder_count: 0, status: "active", auto_renew: true, billing_cycle: "yearly" };

describe("R-2710 advanceRenewalAfterQuoteEmail", () => {
  it("a pending annual renewal 18 days out → the ladder step Send now would set (early_notice), reminder_count 1, scoped to this quote's link", async () => {
    const { db, updates } = fakeDb(SUB);
    await advanceRenewalAfterQuoteEmail(db, "t1", "Q-1");
    expect(updates).toHaveLength(1);
    expect(updates[0].row).toMatchObject({ renewal_state: "early_notice", reminder_count: 1 });
    expect(updates[0].eqs).toEqual([["id", "s1"], ["tenant_id", "t1"], ["renewal_quote_id", "Q-1"]]);
  });
  it("no linked subscription / Won't renew / split-billed / suspended → nothing moves", async () => {
    for (const s of [null, { ...SUB, auto_renew: false }, { ...SUB, billing_cycle: "monthly" }, { ...SUB, renewal_state: "suspended" }]) {
      const { db, updates } = fakeDb(s);
      await advanceRenewalAfterQuoteEmail(db, "t1", "Q-1");
      expect(updates).toHaveLength(0);
    }
  });
  it("the quote send route calls it after the status flip, only for a renewal quote; Send now uses the same step rule", () => {
    const send = readFileSync(join(process.cwd(), "src/app/api/quotes/[id]/send/route.ts"), "utf8");
    const flip = send.indexOf('.update({ status: "sent" })');
    const call = send.indexOf("advanceRenewalAfterQuoteEmail(supabase");
    expect(call).toBeGreaterThan(flip);
    expect(send.slice(call - 200, call)).toMatch(/quote\.is_renewal === true/);
    expect(readFileSync(join(process.cwd(), "src/app/api/renewals/send-now/route.ts"), "utf8")).toMatch(/await manualRenewalStep\(supabase, sub, tenant\.grace_period_days\)/);
  });
});
