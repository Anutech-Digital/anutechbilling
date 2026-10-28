/**
 * R-2027: GET /api/public/catalog/buy-workspace — the buy page asks here after it loads when the
 * server's price read failed on a cold start. Website tenant only (never one the caller names),
 * only the fields the page prices with, rate-limited per IP, never cached; and when the price
 * list is unknown it says so (503) instead of an empty list the page could read as "no plans".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const st = vi.hoisted(() => ({
  result: { data: null, error: null } as { data: unknown; error: unknown },
  eqs: [] as Array<[string, unknown]>,
  selects: [] as string[],
  rlOk: true,
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => {
    const q: Record<string, unknown> = {};
    q.from = () => q;
    q.select = (s: string) => { st.selects.push(s); return q; };
    q.eq = (k: string, v: unknown) => { st.eqs.push([k, v]); return q; };
    q.ilike = () => q;
    q.order = () => q;
    q.abortSignal = async () => st.result;
    return q;
  },
}));

vi.mock("@/lib/security/rate-limit", () => ({
  clientIp: () => "1.2.3.4",
  rateLimitShared: async () => (st.rlOk ? { ok: true, remaining: 1, retryAfterSec: 0 } : { ok: false, remaining: 0, retryAfterSec: 60 }),
}));

import { GET } from "./route";
import { __resetBuyCatalogCacheForTests } from "@/app/(public)/buy/workspace/_parts/fetch-catalog";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ROWS = [
  { id: "s", name: "Google Workspace Business Starter", msrp: 299, wholesale: 210, margin_pct: 20, is_active: true, prices: { annual: { msrp: 299, wholesale: 210 }, monthly: { msrp: 360, wholesale: 250 } } },
  { id: "p", name: "Google Workspace Business Plus", msrp: 1500, wholesale: 1100, margin_pct: 20, is_active: true, prices: { annual: { msrp: 1500, wholesale: 1100 } } },
];

const go = (qs = "") => GET(new NextRequest(`https://reselleros.anutech.in/api/public/catalog/buy-workspace${qs}`));

beforeEach(() => {
  st.result = { data: ROWS, error: null }; st.eqs = []; st.selects = []; st.rlOk = true;
  __resetBuyCatalogCacheForTests();
  process.env.BUY_PAGE_TENANT_ID = TENANT;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/public/catalog/buy-workspace (R-2027)", () => {
  it("returns only what the page prices with — no wholesale, no margin, Plus without a price", async () => {
    const r = await go();
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.items).toEqual([
      { id: "s", name: "Google Workspace Business Starter", msrp: 299, prices: { annual: { msrp: 299 }, monthly: { msrp: 360 } } },
      { id: "p", name: "Google Workspace Business Plus", msrp: 0, prices: {} },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/wholesale|margin|210|1100/);
  });

  it("is scoped to the website tenant — a tenant named in the query is ignored", async () => {
    await go("?tenant=22222222-2222-4222-8222-222222222222&tenant_id=x");
    expect(st.eqs.filter(([k]) => k === "tenant_id")).toEqual([["tenant_id", TENANT]]);
  });

  it("price list unknown (every read failed, nothing cached) → 503 items null, never []", async () => {
    st.result = { data: null, error: { message: "TimeoutError" } };
    const r = await go();
    expect(r.status).toBe(503);
    expect((await r.json()).items).toBeNull();
  }, 15_000);

  it("too many requests from one IP → 429 with Retry-After, no read", async () => {
    st.rlOk = false;
    const r = await go();
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(st.selects).toEqual([]);
  });

  it("is never cached by a browser or CDN (a price edit must show at once)", async () => {
    const r = await go();
    expect(r.headers.get("cache-control")).toMatch(/no-store/);
  });
});
