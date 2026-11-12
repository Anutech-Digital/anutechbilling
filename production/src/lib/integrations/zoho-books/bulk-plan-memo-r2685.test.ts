/**
 * R-2685 — "Reconcile from Zoho" planned again after every page of 8 lines. Each row's own plan is now
 * remembered (planAll's memo), so a 500-line run plans each row once instead of ~31 times on average —
 * and the plan is EXACTLY what a fresh plan of the same rows gives (nothing about booking changes).
 */
import { describe, expect, it } from "vitest";
import { planAllWithZohoSales, type PlanMemo } from "./bulk-zoho-sales";
import { createLineMemo } from "@/lib/banking/line-memo";
import type { PlanRow } from "./bulk-reconcile-plan";
import { zohoBulkRun } from "@/lib/banking/__fixtures__/zoho-bulk-rows";

const PAGE = 8;

/** A typed sale line's key is a running number (payment-prefill typedSeq) — unique, not part of the plan; a remembered
 *  row keeps its key, a fresh plan draws new ones. Compared without it. */
const same = (p: readonly PlanRow[]) => JSON.parse(JSON.stringify(p, (k, v) => (k === "key" && /^zoho-line-\d+$/.test(String(v)) ? "zoho-line" : v)));

/** The plan memo, counting how many row plans were really worked out (every entry of every row's map). */
function countingMemo(): { memo: PlanMemo; computed: () => number } {
  const inner: PlanMemo = createLineMemo();
  const maps = new Set<Map<string, PlanRow | null>>();
  return {
    memo: { reset: (i) => inner.reset(i), get: (line, compute) => { const m = inner.get(line, compute); maps.add(m); return m; } },
    computed: () => [...maps].reduce((s, m) => s + m.size, 0),
  };
}

describe("R-2685 Reconcile from Zoho — each row planned once across pages, same plan", () => {
  const { rows, ctx } = zohoBulkRun(240);

  it("page by page with the memo = a fresh plan of the same rows, at every page", () => {
    const { memo } = countingMemo();
    for (let n = PAGE; n <= 96; n += PAGE) {   // a fresh plan per page is the slow way — 12 pages are enough
      const part = rows.slice(0, n);
      expect(same(planAllWithZohoSales(part, ctx, memo))).toEqual(same(planAllWithZohoSales(part, ctx)));
    }
  });

  it("the run-wide pass still demotes older new subscriptions of the same customer + domain + product", () => {
    const plan = planAllWithZohoSales(rows, ctx, countingMemo().memo);
    expect(plan.some((p) => p.lines.some((l) => l.action === "charge_on_new"))).toBe(true);
  });

  it("each row's own plan is worked out once, however many pages follow", () => {
    const { memo, computed } = countingMemo();
    for (let n = PAGE; n <= rows.length; n += PAGE) planAllWithZohoSales(rows.slice(0, n), ctx, memo);
    // each row once, plus the rows a later line demotes (their charge-on-new plan) — never once per page
    expect(computed()).toBeGreaterThanOrEqual(rows.length);
    expect(computed()).toBeLessThan(rows.length * 1.5);
  });

  it("a remembered row is never changed by the run-wide passes (they get a copy)", () => {
    const { memo } = countingMemo();
    const a = planAllWithZohoSales(rows, ctx, memo);
    const b = planAllWithZohoSales(rows, ctx, memo);
    expect(same(b)).toEqual(same(a));
    expect(b[0]).not.toBe(a[0]);
  });

  it("new customers / subscriptions (a new ctx) → every row planned again", () => {
    const { memo, computed } = countingMemo();
    planAllWithZohoSales(rows, ctx, memo);
    const once = computed();
    planAllWithZohoSales(rows, { ...ctx }, memo);
    expect(computed()).toBe(once * 2);
  });
});
