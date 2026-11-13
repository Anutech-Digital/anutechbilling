/**
 * R-2661 — GET /api/integrations/zoho-books/day-calls: the signed-in user's own company's Zoho calls
 * today (IST), the budget, Zoho's own refusal, when it carries on. Signed out → 401; the read is
 * filtered by the caller's tenant; no row yet → 0 of budget. Supabase is mocked; Zoho is never called.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { istDayOf } from "@/lib/integrations/zoho-books/zoho-day-budget";

const st = vi.hoisted(() => ({
  role: "accountant" as string | null,
  row: null as null | { day: string; calls: number; limit_hit_at: string | null },
  filters: [] as Array<[string, unknown]>,
  fail: false,
}));

vi.mock("@/lib/integrations/zoho-books/store", () => ({
  resolveZohoCaller: async () => (st.role === null ? null : {
    userId: "u1", tenantId: "t-own", role: st.role, canManage: true,
    admin: {
      from: () => {
        const q = {
          select: () => q,
          eq: (k: string, v: unknown) => { st.filters.push([k, v]); return q; },
          limit: async () => (st.fail ? { data: null, error: { message: "boom" } } : { data: st.row ? [st.row] : [], error: null }),
        };
        return q;
      },
    },
  }),
}));

import { GET } from "./route";

beforeEach(() => { st.role = "accountant"; st.row = null; st.filters = []; st.fail = false; vi.unstubAllEnvs(); });

describe("R-2661 day-calls route", () => {
  it("signed out → 401", async () => {
    st.role = null;
    expect((await GET()).status).toBe(401);
  });

  it("no row yet → 0 of the budget, not spent; read filtered by the caller's own tenant and today's IST day", async () => {
    vi.stubEnv("ZOHO_DAY_BUDGET", "2500");
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, calls: 0, budget: 2500, limitHitAt: null, spent: false });
    expect(body.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof body.retryAt).toBe("number");
    expect(st.filters).toContainEqual(["tenant_id", "t-own"]);
    expect(st.filters).toContainEqual(["day", body.day]);
  });

  it("a row: its count; Zoho's own refusal makes it spent even under the budget", async () => {
    const day = istDayOf(Date.now());
    st.row = { day, calls: 612, limit_hit_at: null };
    let body = await (await GET()).json();
    expect(body).toMatchObject({ ok: true, calls: 612, budget: 900, spent: false });
    st.row = { day, calls: 12, limit_hit_at: "2026-11-13T04:24:00+00:00" };
    body = await (await GET()).json();
    expect(body).toMatchObject({ ok: true, calls: 12, limitHitAt: "2026-11-13T04:24:00+00:00", spent: true });
  });

  it("the database not answering → 500 with a plain message (never a wrong number)", async () => {
    st.fail = true;
    const res = await GET();
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);
  });
});
