/**
 * R-2027 (27 Oct 2026): the first load after a server start logged "[buy/workspace] catalog
 * fetch failed: TimeoutError" — ONE 3-second read of the price list, then [] and the page priced
 * itself from FALLBACK_TIERS (typed prices that go wrong the day the catalogue changes). Now the
 * read is retried with backoff inside ~6 s, the last good list of THIS tenant (10 min) is used
 * when every try fails, and with neither the page gets null — "not known yet", never [] and
 * never a typed price.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Result = { data: unknown; error: unknown } | "throw";
const st = vi.hoisted(() => ({
  results: [] as Array<{ data: unknown; error: unknown } | "throw">,
  eqs: [] as Array<[string, unknown]>,
  selects: [] as string[],
  timeouts: [] as number[],
  calls: 0,
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => {
    const q: Record<string, unknown> = {};
    q.from = () => q;
    q.select = (s: string) => { st.selects.push(s); return q; };
    q.eq = (k: string, v: unknown) => { st.eqs.push([k, v]); return q; };
    q.ilike = () => q;
    q.order = () => q;
    q.abortSignal = () => {
      st.calls++;
      const r: Result = st.results.shift() ?? { data: null, error: { message: "no result queued" } };
      if (r === "throw") return Promise.reject(new Error("TimeoutError: The operation was aborted due to timeout"));
      return Promise.resolve(r);
    };
    return q;
  },
}));

import { readBuyCatalog, __resetBuyCatalogCacheForTests, CATALOG_READ_BUDGET_MS, CATALOG_CACHE_TTL_MS } from "./fetch-catalog";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const ROWS = [
  { id: "s", name: "Google Workspace Business Starter", msrp: 299, wholesale: 210, margin_pct: 20, is_active: true, prices: { annual: { msrp: 299, wholesale: 210 }, monthly: { msrp: 360, wholesale: 250 } } },
  { id: "d", name: "Google Workspace Business Standard", msrp: 1199, wholesale: 900, margin_pct: 20, is_active: true, prices: { annual: { msrp: 1199, wholesale: 900 } } },
  { id: "p", name: "Google Workspace Business Plus", msrp: 1500, wholesale: 1100, margin_pct: 20, is_active: true, prices: { annual: { msrp: 1500, wholesale: 1100 } } },
];
const OK = { data: ROWS, error: null };
const FAIL = { data: null, error: { message: "TimeoutError: The operation was aborted due to timeout" } };

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  st.results = []; st.eqs = []; st.selects = []; st.calls = 0;
  __resetBuyCatalogCacheForTests();
  process.env.BUY_PAGE_TENANT_ID = TENANT_A;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("readBuyCatalog (R-2027)", () => {
  it("the tries and the pauses fit in about 6 seconds", () => {
    expect(CATALOG_READ_BUDGET_MS).toBeGreaterThanOrEqual(5_000);
    expect(CATALOG_READ_BUDGET_MS).toBeLessThanOrEqual(6_500);
    expect(CATALOG_CACHE_TTL_MS).toBe(10 * 60_000);
  });

  it("first read times out (cold start) → a retry gets the catalogue prices", async () => {
    st.results = ["throw", OK];
    const items = await readBuyCatalog();
    expect(items?.map((i) => i.msrp)).toEqual([299, 1199, 0]);
    expect(st.calls).toBe(2);
    expect(st.eqs.filter(([k]) => k === "tenant_id").every(([, v]) => v === TENANT_A)).toBe(true);
  });

  it("two failures, the third try answers (backoff, still inside the budget)", async () => {
    st.results = [FAIL, "throw", OK];
    expect((await readBuyCatalog())?.[0].msrp).toBe(299);
    expect(st.calls).toBe(3);
  });

  it("our cost never leaves: wholesale 0, no margin, Plus without a price (R-328)", async () => {
    st.results = [OK];
    const items = await readBuyCatalog();
    expect(st.selects.join(" ")).not.toMatch(/wholesale|margin/);
    expect(JSON.stringify(items)).not.toMatch(/210|900|1100/);
    const plus = items!.find((i) => i.id === "p")!;
    expect(plus.msrp).toBe(0);
    expect(plus.prices).toEqual({});
  });

  it("every try fails → the last good list of the same tenant", async () => {
    st.results = [OK];
    await readBuyCatalog();
    st.results = [FAIL, FAIL, FAIL];
    const items = await readBuyCatalog();
    expect(items?.map((i) => i.msrp)).toEqual([299, 1199, 0]);
    expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(/last good/);
  });

  it("every try fails with nothing cached → null (unknown), never [] and never a typed price", async () => {
    st.results = [FAIL, FAIL, FAIL];
    expect(await readBuyCatalog()).toBeNull();
    const lines = warn.mock.calls.map((c) => c.join(" "));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.every((l) => /catalog read failed/.test(l) && /\d+\s?ms/.test(l))).toBe(true);
  });

  it("another tenant's cached list is never used", async () => {
    st.results = [OK];
    await readBuyCatalog();                    // cached under TENANT_A
    process.env.BUY_PAGE_TENANT_ID = TENANT_B;
    st.results = [FAIL, FAIL, FAIL];
    expect(await readBuyCatalog()).toBeNull();
  });

  it("a cached list past its 10-minute life is not used", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      st.results = [OK];
      await readBuyCatalog();
      vi.setSystemTime(Date.now() + 11 * 60_000);
      st.results = [FAIL, FAIL, FAIL];
      expect(await readBuyCatalog()).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("a catalogue that answers empty is an honest [] — no retry, it replaces the cache", async () => {
    st.results = [OK];
    await readBuyCatalog();
    st.results = [{ data: [], error: null }];
    expect(await readBuyCatalog()).toEqual([]);
    expect(st.calls).toBe(2);
    st.results = [FAIL, FAIL, FAIL];
    expect(await readBuyCatalog()).toEqual([]);
  });

  it("no website tenant configured → [] without a database read", async () => {
    delete process.env.BUY_PAGE_TENANT_ID;
    expect(await readBuyCatalog()).toEqual([]);
    expect(st.calls).toBe(0);
  });
});
