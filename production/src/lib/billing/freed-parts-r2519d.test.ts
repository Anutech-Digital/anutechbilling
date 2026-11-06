/**
 * R-2519d (coordinator, BITDECENTRO): the wrong Oct proforma Q-A378-27-0947 is cancelled while the Nov
 * row is already laid. The billing job must bill the freed Oct part FIRST (earliest), before the
 * subscription's current term — the term run never reaches an earlier term.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { billFreedParts } from "./sync-instalments.server";

function fakeDb(rows: { billing_id: string; subscription_id: string; tenant_id: string; period_start: string }[]) {
  const calls: string[] = [];
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "freed_parts_due") return { data: rows, error: null };
      if (fn === "bill_subscription_instalment") {
        calls.push(String(args.p_billing_id));
        return { data: { action: "request", quote_id: `PI-${String(args.p_billing_id)}`, created: true, gross: 6372 }, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
  };
  return { db: db as never, calls };
}

describe("R-2519d — the billing job bills freed (cancelled) parts first, earliest first", () => {
  it("BITDECENTRO: the freed Oct part is billed; parts are taken oldest first; other companies' are left to their own gate", async () => {
    const { db, calls } = fakeDb([
      { billing_id: "nov-x", subscription_id: "s2", tenant_id: "t1", period_start: "2026-11-12" },
      { billing_id: "oct",   subscription_id: "s1", tenant_id: "t1", period_start: "2026-10-12" },
      { billing_id: "blocked", subscription_id: "s3", tenant_id: "t-off", period_start: "2026-09-01" },
    ]);
    const r = await billFreedParts(db, { todayISO: "2026-11-15", dryRun: false, allowed: (t) => t === "t1" });
    expect(calls).toEqual(["oct", "nov-x"]);
    expect(r.parts.map((p) => [p.subscription_id, p.result.requests[0]?.quote_id])).toEqual([["s1", "PI-oct"], ["s2", "PI-nov-x"]]);
    expect(r.errors).toEqual([]);
  });

  it("the cron bills them BEFORE the per-subscription term run", () => {
    const src = readFileSync(join(__dirname, "../../app/api/cron/billing/route.ts"), "utf8");
    const freed = src.indexOf("billFreedParts(supabase");
    const loop = src.indexOf("syncSubscriptionInstalments({ supabase, sub, quote, todayISO: today, dryRun })");
    expect(freed).toBeGreaterThan(0);
    expect(loop).toBeGreaterThan(freed);
  });
});
