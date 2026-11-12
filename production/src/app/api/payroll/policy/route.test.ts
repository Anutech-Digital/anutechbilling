/**
 * R-2700: /api/payroll/policy — 401 signed out, 403 non-owner, bad input refused with the
 * sentence, owner writes ONLY the payroll_* columns of HIS OWN tenant row; GET returns the
 * defaults when there is no row.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const T1 = "11111111-1111-4111-8111-111111111111";
const OWNER = "a0000000-0000-4000-8000-000000000001";
const MGR = "a0000000-0000-4000-8000-000000000002";
const USERS: Record<string, { tenant_id: string; role: string }> = {
  [OWNER]: { tenant_id: T1, role: "owner" },
  [MGR]: { tenant_id: T1, role: "manager" },
};

const st = vi.hoisted(() => ({
  sessionUserId: null as string | null,
  row: null as Record<string, unknown> | null,
  upserts: [] as Array<{ v: Record<string, unknown>; opts: unknown }>,
}));

function userClient() {
  return {
    auth: { getUser: async () => ({ data: { user: st.sessionUserId ? { id: st.sessionUserId } : null } }) },
    from(table: string) {
      const q = {
        select() { return q; },
        eq(_c: string, id: string) { (q as { id?: string }).id = id; return q; },
        async single() { return { data: USERS[(q as { id?: string }).id ?? ""] ?? null, error: null }; },
        async maybeSingle() { return { data: table === "attendance_settings" ? st.row : null, error: null }; },
      };
      return q;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => userClient(),
  createAdminClientFor: () => ({
    from: () => ({
      upsert: async (v: Record<string, unknown>, opts: unknown) => { st.upserts.push({ v, opts }); return { error: null }; },
    }),
  }),
}));

import { GET, POST } from "./route";

const good = { pfDefault: true, pfFullWageDefault: false, esiDefault: true, gratuity: false, ctcIncludesEmployer: false, basicPct: 40 };
const post = (body: unknown) => POST({ json: async () => body } as unknown as NextRequest);

beforeEach(() => { st.sessionUserId = null; st.row = null; st.upserts = []; });

describe("R-2700 /api/payroll/policy", () => {
  it("signed out → 401 both ways", async () => {
    expect((await GET()).status).toBe(401);
    expect((await post({ policy: good })).status).toBe(401);
  });
  it("GET with no row → the pre-R-2700 defaults", async () => {
    st.sessionUserId = MGR;
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).policy).toEqual({ pfDefault: false, pfFullWageDefault: false, esiDefault: true, gratuity: true, ctcIncludesEmployer: true, basicPct: 50 });
  });
  it("non-owner POST → 403, nothing written", async () => {
    st.sessionUserId = MGR;
    const res = await post({ policy: good });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Only the owner can change the payroll policy");
    expect(st.upserts).toHaveLength(0);
  });
  it("bad Basic % → 400 with the sentence, nothing written", async () => {
    st.sessionUserId = OWNER;
    const res = await post({ policy: { ...good, basicPct: 150 } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Basic must be between 10% and 100% of the salary.");
    expect(st.upserts).toHaveLength(0);
  });
  it("owner POST → upserts only the payroll_* columns on his own tenant", async () => {
    st.sessionUserId = OWNER;
    const res = await post({ policy: good });
    expect(res.status).toBe(200);
    expect(st.upserts).toHaveLength(1);
    const { v, opts } = st.upserts[0];
    expect(opts).toEqual({ onConflict: "tenant_id" });
    expect(v.tenant_id).toBe(T1);
    expect(Object.keys(v).filter((k) => k !== "tenant_id" && k !== "updated_at").every((k) => k.startsWith("payroll_"))).toBe(true);
    expect(v).toMatchObject({ payroll_pf_default: true, payroll_gratuity: false, payroll_ctc_includes_employer: false, payroll_basic_pct: 40 });
    expect(v).not.toHaveProperty("allowed_ips");
    expect(v).not.toHaveProperty("require_selfie");
  });
});
