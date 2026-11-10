/**
 * R-2584 — loadScheduledReduction ignores a scheduled seat cut dated before today (IST): its
 * renewal passed without it being applied, so it must not block a new cut nor show as pending.
 */
import { describe, it, expect } from "vitest";
import { loadScheduledReduction, type ReduceSeatsSub } from "./load";

type Row = { id: string; seats_before: number; seats_after: number; effective_date: string; status: string; subscription_id: string; tenant_id: string };

/** A tiny query fake that really applies eq/gte filters to the rows, like PostgREST. */
function fakeAdmin(rows: Row[]) {
  return {
    from: () => {
      let out = [...rows];
      const q = {
        select: () => q,
        eq: (k: keyof Row, v: unknown) => { out = out.filter((r) => r[k] === v); return q; },
        gte: (k: keyof Row, v: string) => { out = out.filter((r) => String(r[k]) >= v); return q; },
        order: () => q,
        limit: (n: number) => { out = out.slice(0, n); return q; },
        maybeSingle: async () => ({ data: out[0] ?? null, error: null }),
      };
      return q;
    },
  } as never;
}

const SUB = { id: "s-1", tenant_id: "t-1" } as ReduceSeatsSub;
const row = (effective_date: string): Row => ({
  id: `r-${effective_date}`, seats_before: 10, seats_after: 8, effective_date, status: "scheduled", subscription_id: "s-1", tenant_id: "t-1",
});

describe("loadScheduledReduction (R-2584)", () => {
  it("a scheduled cut dated before today is ignored", async () => {
    expect(await loadScheduledReduction(fakeAdmin([row("2026-11-07")]), SUB, "2026-11-08")).toBeNull();
  });
  it("a cut scheduled for today or later is still shown", async () => {
    expect((await loadScheduledReduction(fakeAdmin([row("2026-11-08")]), SUB, "2026-11-08"))?.effective_date).toBe("2026-11-08");
    expect((await loadScheduledReduction(fakeAdmin([row("2026-11-07"), row("2027-04-01")]), SUB, "2026-11-08"))?.effective_date).toBe("2027-04-01");
  });
});
