/**
 * R-2024 (27 Oct 2026): the first load after a server start showed the neutral "Google Workspace"
 * header — readBuyBrand made ONE 3-second read of the website tenant's row and gave up. Now: one
 * retry inside a ~6 s budget, then the last good brand of THIS tenant (never another tenant's),
 * and every failed read is logged with how long it took.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const st = vi.hoisted(() => ({
  results: [] as Array<{ data: unknown; error: unknown } | "throw">,
  eqs: [] as Array<[string, unknown]>,
  selects: [] as string[],
  calls: 0,
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => {
    const q: Record<string, unknown> = {};
    q.from = () => q;
    q.select = (s: string) => { st.selects.push(s); return q; };
    q.eq = (k: string, v: unknown) => { st.eqs.push([k, v]); return q; };
    q.abortSignal = () => q;
    q.maybeSingle = async () => {
      st.calls++;
      const r = st.results.shift() ?? { data: null, error: { message: "no result queued" } };
      if (r === "throw") throw new Error("The operation was aborted due to timeout");
      return r;
    };
    return q;
  },
}));

import { readBuyBrand, __resetBuyBrandCacheForTests, BRAND_READ_BUDGET_MS } from "./fetch-brand";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const ROW = { name: "Acme Cloud Pvt Ltd", logo_url: null, gstin: "07ABCDE1234F1Z5", address: "1 Road", pin_code: "110001", state: "Delhi", state_code: "07", phone: "8800000000", email: "hi@acme.test" };
const OK = { data: ROW, error: null };
const FAIL = { data: null, error: { message: "TypeError: fetch failed" } };

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  st.results = []; st.eqs = []; st.selects = []; st.calls = 0;
  __resetBuyBrandCacheForTests();
  process.env.BUY_PAGE_TENANT_ID = TENANT_A;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("readBuyBrand (R-2024)", () => {
  it("the whole retry fits in about 6 seconds", () => {
    expect(BRAND_READ_BUDGET_MS).toBeGreaterThanOrEqual(5_000);
    expect(BRAND_READ_BUDGET_MS).toBeLessThanOrEqual(6_500);
  });

  it("first read fails (cold start) → the retry gets the company, not the neutral header", async () => {
    st.results = [FAIL, OK];
    const b = await readBuyBrand();
    expect(b?.name).toBe("Acme Cloud Pvt Ltd");
    expect(st.calls).toBe(2);
    expect(st.eqs.every(([k, v]) => k === "id" && v === TENANT_A)).toBe(true);
  });

  it("a timeout (thrown abort) is retried too", async () => {
    st.results = ["throw", OK];
    expect((await readBuyBrand())?.name).toBe("Acme Cloud Pvt Ltd");
  });

  it("both reads fail → the last good brand of the same tenant", async () => {
    st.results = [OK];
    expect((await readBuyBrand())?.name).toBe("Acme Cloud Pvt Ltd");
    st.results = [FAIL, "throw"];
    const b = await readBuyBrand();
    expect(b?.name).toBe("Acme Cloud Pvt Ltd");
    expect(b?.gstin).toBe("07ABCDE1234F1Z5");
  });

  it("another tenant's cached brand is never used", async () => {
    st.results = [OK];
    await readBuyBrand();                     // cached under TENANT_A
    process.env.BUY_PAGE_TENANT_ID = TENANT_B;
    st.results = [FAIL, FAIL];
    expect(await readBuyBrand()).toBeNull();
  });

  it("an old cached brand (past its TTL) is not used", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      st.results = [OK];
      await readBuyBrand();
      vi.setSystemTime(Date.now() + 31 * 60_000);
      st.results = [FAIL, FAIL];
      expect(await readBuyBrand()).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("both fail with no cache → null, and each failure is logged with its duration", async () => {
    st.results = [FAIL, FAIL];
    expect(await readBuyBrand()).toBeNull();
    const lines = warn.mock.calls.map((c) => c.join(" "));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.every((l) => /brand read failed/.test(l) && /\d+\s?ms/.test(l))).toBe(true);
  });

  it("no website tenant configured → null without a database read", async () => {
    delete process.env.BUY_PAGE_TENANT_ID;
    expect(await readBuyBrand()).toBeNull();
    expect(st.calls).toBe(0);
  });

  it("a tenant row without a name is not a failure — no retry, no stale brand", async () => {
    st.results = [OK];
    await readBuyBrand();
    st.results = [{ data: null, error: null }];
    expect(await readBuyBrand()).toBeNull();
    expect(st.calls).toBe(2);
  });
});
