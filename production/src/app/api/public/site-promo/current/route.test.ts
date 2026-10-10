/**
 * R-705: the promo banner endpoint — a bad tier is the caller's 400, an unreachable database
 * a 503 with Retry-After, and only a real database fault a 500.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const st = vi.hoisted(() => ({
  result: { data: null, error: null } as { data: unknown; error: unknown },
  orFilters: [] as string[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => {
    const q: Record<string, unknown> = {};
    for (const k of ["from", "select", "eq", "lte", "order", "limit"]) q[k] = () => q;
    q.or = (f: string) => { st.orFilters.push(f); return q; };
    q.maybeSingle = async () => st.result;
    return q;
  },
}));

import { GET } from "./route";

const go = (qs = "") => GET(new NextRequest(`https://reselleros.anutech.in/api/public/site-promo/current${qs}`));

beforeEach(() => {
  st.result = { data: null, error: null };
  st.orFilters = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/public/site-promo/current (R-705)", () => {
  it("no promo → 200 with promo null", async () => {
    const r = await go("?tier=standard&seats=10");
    expect(r.status).toBe(200);
    expect((await r.json()).promo).toBeNull();
    expect(st.orFilters).toEqual(["applies_to_tier.is.null,applies_to_tier.eq.standard"]);
  });

  it.each(["standard,applies_to_tier.neq.x", "a)b", "x".repeat(41)])(
    "refuses tier %s with 400 and never builds the filter",
    async (tier) => {
      const r = await go(`?tier=${encodeURIComponent(tier)}`);
      expect(r.status).toBe(400);
      expect(st.orFilters).toEqual([]);
    },
  );

  it("database not reachable → 503 + Retry-After, not 500", async () => {
    st.result = { data: null, error: { message: "TypeError: fetch failed", details: "ConnectTimeoutError (UND_ERR_CONNECT_TIMEOUT)", code: "" } };
    const r = await go("?tier=standard");
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("30");
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.error).not.toMatch(/fetch failed|Timeout/i);
  });

  it("a real database fault stays a 500 with the public sentence", async () => {
    st.result = { data: null, error: { message: "column x does not exist", code: "42703" } };
    const r = await go();
    expect(r.status).toBe(500);
    expect((await r.json()).error).toMatch(/current offer/);
  });
});
