/**
 * R-2589 — loadOpenPlanChangeQuote: only a linked quote whose first line carries plan_change (and
 * buys no time) counts as an open plan-change quote; a renewal quote or no link does not.
 */
import { describe, it, expect } from "vitest";
import { loadOpenPlanChangeQuote, type ReduceSeatsSub } from "./load";

function admin(row: Record<string, unknown> | null) {
  const calls: unknown[] = [];
  const q = {
    select: () => q,
    eq: (col: string, v: unknown) => { calls.push([col, v]); return q; },
    maybeSingle: async () => ({ data: row }),
  };
  return { client: { from: (t: string) => { calls.push(["from", t]); return q; } } as never, calls };
}
const sub = (renewal_quote_id: string | null) => ({ id: "s-1", tenant_id: "t-1", renewal_quote_id } as unknown as ReduceSeatsSub);

describe("loadOpenPlanChangeQuote (R-2589)", () => {
  it("names the linked plan-change quote", async () => {
    const a = admin({ id: "QT-9", extension_months: 0, line_items: [{ plan_change: { seats: 10 } }] });
    expect(await loadOpenPlanChangeQuote(a.client, sub("QT-9"))).toBe("QT-9");
    expect(a.calls).toContainEqual(["tenant_id", "t-1"]);
  });
  it("a renewal quote (buys time, no plan_change) is not one", async () => {
    const a = admin({ id: "QT-8", extension_months: 12, line_items: [{ name: "Renewal" }] });
    expect(await loadOpenPlanChangeQuote(a.client, sub("QT-8"))).toBeNull();
  });
  it("no linked quote → nothing to read", async () => {
    const a = admin(null);
    expect(await loadOpenPlanChangeQuote(a.client, sub(null))).toBeNull();
    expect(a.calls).toEqual([]);
  });
});
