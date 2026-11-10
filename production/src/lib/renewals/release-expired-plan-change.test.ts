import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { releaseExpiredPlanChanges, dropReleasedLinks, tenantsWithLinkedQuote } from "./release-expired-plan-change";

describe("R-2590 (c): expired Change plan quote lets go of the renewal link", () => {
  it("asks only tenants that have a linked quote, once each", () => {
    expect(tenantsWithLinkedQuote([
      { tenant_id: "t1", renewal_quote_id: "Q-1" },
      { tenant_id: "t1", renewal_quote_id: "Q-2" },
      { tenant_id: "t2", renewal_quote_id: null },
      { tenant_id: "t3", renewal_quote_id: "Q-3" },
    ])).toEqual(["t1", "t3"]);
  });

  it("calls the SQL rule per tenant, collects released rows, keeps going after one tenant fails", async () => {
    const calls: unknown[] = [];
    const supabase = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push([fn, args]);
        if (args.p_tenant_id === "bad") return { data: null, error: { message: "boom" } };
        return { data: [{ subscription_id: `s-${String(args.p_tenant_id)}`, quote_id: "Q-9" }], error: null };
      },
    };
    const r = await releaseExpiredPlanChanges(supabase, ["t1", "bad", "t2"]);
    expect(calls).toEqual([
      ["release_expired_plan_change_quotes", { p_tenant_id: "t1" }],
      ["release_expired_plan_change_quotes", { p_tenant_id: "bad" }],
      ["release_expired_plan_change_quotes", { p_tenant_id: "t2" }],
    ]);
    expect(r.released).toEqual([{ subscription_id: "s-t1", quote_id: "Q-9" }, { subscription_id: "s-t2", quote_id: "Q-9" }]);
    expect(r.errors).toEqual([{ tenantId: "bad", message: "boom" }]);
  });

  it("drops only the exact released link from rows already read", () => {
    const subs = [
      { id: "s1", renewal_quote_id: "Q-1" as string | null },
      { id: "s2", renewal_quote_id: "Q-NEW" as string | null }, // link moved meanwhile
      { id: "s3", renewal_quote_id: "Q-3" as string | null },
    ];
    dropReleasedLinks(subs, [{ subscription_id: "s1", quote_id: "Q-1" }, { subscription_id: "s2", quote_id: "Q-OLD" }]);
    expect(subs.map((s) => s.renewal_quote_id)).toEqual([null, "Q-NEW", "Q-3"]);
  });

  it("the renewals cron releases before it reuses a linked quote", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../app/api/cron/renewals/route.ts"), "utf8");
    const release = src.indexOf("releaseExpiredPlanChanges(");
    expect(release).toBeGreaterThan(0);
    expect(release).toBeLessThan(src.indexOf("splitBilledRenewalStep("));
    expect(release).toBeLessThan(src.indexOf("existingQuoteId: sub.renewal_quote_id"));
  });
});
