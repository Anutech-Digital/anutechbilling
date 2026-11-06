/**
 * R-2524 — the bank account page reads all of an account's lines (5,170 on staging HDFC ··4523),
 * and again after every reconcile save. The pages after the first now go out side by side
 * (fetchPagesInParallel): 6,000 lines = the first page + 5 at once, not 6 one after another.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: Object.assign(() => undefined, { success: () => undefined }) }));

import { BANK_PAGE_PARALLEL, fetchPagesInParallel } from "../bank";

type Ans = { data: number[] | null; error: unknown; count?: number | null };

/** A fake gateway over rows 0..n-1, capped at `size` a page; counts how many requests are in flight. */
function gateway(n: number, opts: { count?: boolean; failAt?: number } = {}) {
  let inFlight = 0;
  let peak = 0;
  const calls: Array<[number, number, boolean]> = [];
  const page = (from: number, to: number, withCount = false): Promise<Ans> => {
    calls.push([from, to, withCount]);
    inFlight++;
    peak = Math.max(peak, inFlight);
    return new Promise((res) => setTimeout(() => {
      inFlight--;
      if (opts.failAt === from) return res({ data: null, error: { message: "boom" } });
      const rows = Array.from({ length: Math.max(0, Math.min(to, n - 1) - from + 1) }, (_, i) => from + i);
      res({ data: rows, error: null, count: withCount && opts.count !== false ? n : null });
    }, 5));
  };
  return { page, calls, peak: () => peak };
}

describe("R-2524 fetchPagesInParallel", () => {
  it("6,000 rows: every row once, in order, pages after the first fetched side by side", async () => {
    const g = gateway(6000);
    const rows = await fetchPagesInParallel(g.page, 1000);
    expect(rows).toHaveLength(6000);
    expect(rows.every((r, i) => r === i)).toBe(true);
    expect(g.calls[0]).toEqual([0, 999, true]);              // only the first page asks for the count
    expect(g.calls.slice(1).every(([, , c]) => !c)).toBe(true);
    expect(g.peak()).toBe(BANK_PAGE_PARALLEL);                 // 4 at once, never more
    expect(g.calls.length).toBe(7);                            // 6 pages + one empty check (last page was full)
  });

  it("a short account is one request", async () => {
    const g = gateway(420);
    expect(await fetchPagesInParallel(g.page, 1000)).toHaveLength(420);
    expect(g.calls).toHaveLength(1);
  });

  it("no count in the answer → the old one-page-at-a-time loop, still every row", async () => {
    const g = gateway(2500, { count: false });
    const rows = await fetchPagesInParallel(g.page, 1000);
    expect(rows).toHaveLength(2500);
    expect(g.peak()).toBe(1);
  });

  it("lines added while reading (count said 2,000, 2,300 there) are still all read", async () => {
    let n = 2000;
    const g = gateway(2300);
    const page = (from: number, to: number, withCount = false) => g.page(from, to, withCount).then((a) => ({ ...a, count: withCount ? n : a.count }));
    n = 2000;
    const rows = await fetchPagesInParallel(page, 1000);
    expect(rows).toHaveLength(2300);
  });

  it("a failed page fails the read — never a short list taken as the whole account", async () => {
    const g = gateway(6000, { failAt: 3000 });
    await expect(fetchPagesInParallel(g.page, 1000)).rejects.toMatchObject({ message: "boom" });
  });
});
