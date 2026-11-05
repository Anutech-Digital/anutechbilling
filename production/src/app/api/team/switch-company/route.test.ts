/**
 * R-2476: POST /api/team/switch-company { tenantId } — the company switcher's one write.
 *   · not signed in → 401, RPC never called;
 *   · no / bad tenantId → 400 with a plain reason;
 *   · the switch runs as the SESSION (switch_company decides membership + MFA in Postgres);
 *   · a refusal comes back 403 with the function's own words (next step included);
 *   · success drops the gateway's cached role for this login, so the next data request is judged
 *     with the NEW company's role (contact masking / limits, R-1009 / R-1005) — not the old one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const st = vi.hoisted(() => ({
  user: { id: "u-1" } as { id: string } | null,
  rpcCalls: [] as { fn: string; args: unknown }[],
  rpcError: null as { message: string } | null,
  invalidated: [] as string[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: st.user } }) },
    rpc: async (fn: string, args: unknown) => {
      st.rpcCalls.push({ fn, args });
      return st.rpcError ? { data: null, error: st.rpcError } : { data: (args as { p_tenant_id: string }).p_tenant_id, error: null };
    },
  }),
}));
vi.mock("@/server/postgrest/gateway-limits", () => ({
  invalidateGatewayRole: (id: string) => { st.invalidated.push(id); },
}));

import { POST } from "./route";

const B = "c2476000-0000-4000-8000-000000000001";
const post = (body: unknown) =>
  POST(new NextRequest("http://x/api/team/switch-company", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));

beforeEach(() => {
  st.user = { id: "u-1" };
  st.rpcCalls = [];
  st.rpcError = null;
  st.invalidated = [];
});

describe("POST /api/team/switch-company (R-2476)", () => {
  it("not signed in → 401, nothing called", async () => {
    st.user = null;
    const res = await post({ tenantId: B });
    expect(res.status).toBe(401);
    expect(st.rpcCalls).toHaveLength(0);
  });

  it("missing or bad company id → 400 with a plain reason", async () => {
    for (const body of [{}, { tenantId: "abc" }, "not json"]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Pick a company from the list/);
    }
    expect(st.rpcCalls).toHaveLength(0);
  });

  it("switches through switch_company as the session and drops the gateway's cached role", async () => {
    const res = await post({ tenantId: B });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, tenantId: B });
    expect(st.rpcCalls).toEqual([{ fn: "switch_company", args: { p_tenant_id: B } }]);
    expect(st.invalidated).toEqual(["u-1"]);
  });

  it("a refusal comes back 403 with the function's own words; the cache is left alone", async () => {
    st.rpcError = { message: "You are not a member of that company, or your access there has ended. Ask that company's owner to invite you again." };
    const res = await post({ tenantId: B });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/invite you again/);
    expect(st.invalidated).toEqual([]);
  });
});
