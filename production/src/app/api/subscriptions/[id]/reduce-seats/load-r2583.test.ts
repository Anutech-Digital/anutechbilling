/**
 * R-2583 — loadCutRenewalQuote: the linked renewal quote counts as "made with the scheduled cut"
 * only when it is a renewal quote for exactly the cut's seats (fewer than the subscription has).
 */
import { describe, it, expect } from "vitest";
import { loadCutRenewalQuote, type ReduceSeatsSub, type ScheduledReduction } from "./load";

function admin(row: Record<string, unknown> | null) {
  const calls: unknown[] = [];
  const q = {
    select: () => q,
    eq: (col: string, v: unknown) => { calls.push([col, v]); return q; },
    maybeSingle: async () => ({ data: row }),
  };
  return { client: { from: (t: string) => { calls.push(["from", t]); return q; } } as never, calls };
}
const sub = (renewal_quote_id: string | null) => ({ id: "s-1", tenant_id: "t-1", seats: 10, renewal_quote_id } as unknown as ReduceSeatsSub);
const cut: ScheduledReduction = { id: "r-1", seats_before: 10, seats_after: 7, effective_date: "2027-04-01" };

describe("loadCutRenewalQuote (R-2583)", () => {
  it("names a linked renewal quote made for the cut seats", async () => {
    const a = admin({ id: "QT-9", seats: 7, is_renewal: true, extension_months: 12 });
    expect(await loadCutRenewalQuote(a.client, sub("QT-9"), cut)).toEqual({ id: "QT-9", seats: 7 });
    expect(a.calls).toContainEqual(["tenant_id", "t-1"]);
  });
  it("a renewal quote at the full seats is not one (removing the cut changes nothing on it)", async () => {
    const a = admin({ id: "QT-8", seats: 10, is_renewal: true, extension_months: 12 });
    expect(await loadCutRenewalQuote(a.client, sub("QT-8"), cut)).toBeNull();
  });
  it("a plan-change quote (buys no time) is not one", async () => {
    const a = admin({ id: "QT-7", seats: 7, is_renewal: true, extension_months: 0 });
    expect(await loadCutRenewalQuote(a.client, sub("QT-7"), cut)).toBeNull();
  });
  it("no link or no scheduled cut → nothing to read", async () => {
    const a = admin(null);
    expect(await loadCutRenewalQuote(a.client, sub(null), cut)).toBeNull();
    expect(await loadCutRenewalQuote(a.client, sub("QT-1"), null)).toBeNull();
    expect(a.calls).toEqual([]);
  });
});
