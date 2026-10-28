/**
 * R-2024: GET /api/public/brand — the buy page asks for the website company's brand after
 * mount when the server read failed on a cold start. Website tenant only (never one the caller
 * names), only the fields the page already shows, rate-limited per IP.
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
    q.abortSignal = () => q;
    q.maybeSingle = async () => st.result;
    return q;
  },
}));

vi.mock("@/lib/security/rate-limit", () => ({
  clientIp: () => "1.2.3.4",
  rateLimitShared: async () => (st.rlOk ? { ok: true, remaining: 1, retryAfterSec: 0 } : { ok: false, remaining: 0, retryAfterSec: 60 }),
}));

import { GET } from "./route";
import { __resetBuyBrandCacheForTests } from "@/app/(public)/buy/workspace/_parts/fetch-brand";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ROW = { name: "Acme Cloud Pvt Ltd", logo_url: "https://x.test/l.png", gstin: "07ABCDE1234F1Z5", address: "1 Road", pin_code: "110001", state: "Delhi", state_code: "07", phone: "8800000000", email: "hi@acme.test" };

const go = (qs = "") => GET(new NextRequest(`https://reselleros.anutech.in/api/public/brand${qs}`));

beforeEach(() => {
  st.result = { data: ROW, error: null }; st.eqs = []; st.selects = []; st.rlOk = true;
  __resetBuyBrandCacheForTests();
  process.env.BUY_PAGE_TENANT_ID = TENANT;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("GET /api/public/brand (R-2024)", () => {
  it("returns the website tenant's public brand", async () => {
    const r = await go();
    expect(r.status).toBe(200);
    const { brand } = await r.json();
    expect(brand).toEqual({
      name: "Acme Cloud Pvt Ltd", logoUrl: "https://x.test/l.png", gstin: "07ABCDE1234F1Z5",
      address: "1 Road 110001", stateCode: "07", phone: "8800000000", email: "hi@acme.test",
    });
  });

  it("is scoped to the website tenant — a tenant named in the query is ignored", async () => {
    await go("?tenant=22222222-2222-4222-8222-222222222222&tenant_id=x");
    expect(st.eqs).toEqual([["id", TENANT]]);
  });

  it("reads only the public columns the page already shows", async () => {
    await go();
    const cols = st.selects[0].split(",").map((s) => s.trim()).sort();
    expect(cols).toEqual(["address", "email", "gstin", "logo_url", "name", "phone", "pin_code", "state", "state_code"]);
  });

  it("no website tenant configured → brand null, no read", async () => {
    delete process.env.BUY_PAGE_TENANT_ID;
    const r = await go();
    expect((await r.json()).brand).toBeNull();
    expect(st.eqs).toEqual([]);
  });

  it("too many requests from one IP → 429 with Retry-After", async () => {
    st.rlOk = false;
    const r = await go();
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
  });

  it("is never cached by a browser or CDN", async () => {
    const r = await go();
    expect(r.headers.get("cache-control")).toMatch(/no-store/);
  });
});
