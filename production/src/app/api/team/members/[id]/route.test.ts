/**
 * R-2477: DELETE /api/team/members/:id — "Remove from this company".
 * Pinned: the route holds no privilege — it forwards the SESSION to remove_company_member (all
 * rules in SQL), passes the refusal text through unchanged with a fitting status, hides raw text
 * of an unexpected error, and drops the removed login's cached gateway role on success.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const ME = "a0000000-0000-4000-8000-000000000001";
const TARGET = "b0000000-0000-4000-8000-000000000002";

const st = vi.hoisted(() => ({
  user: null as null | { id: string },
  me: { role: "owner", is_active: true } as null | { role: string; is_active: boolean },
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  result: { data: null as unknown, error: null as null | { message: string; code?: string } },
  invalidated: [] as string[],
  adminUsed: false,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: st.user } }) },
    from: () => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: st.me, error: null }) };
      return q;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => { st.rpcCalls.push({ fn, args }); return st.result; },
  }),
  createAdminClient: () => { st.adminUsed = true; throw new Error("no admin client"); },
  createAdminClientFor: () => { st.adminUsed = true; throw new Error("no admin client"); },
}));
vi.mock("@/server/postgrest/gateway-limits", () => ({
  invalidateGatewayRole: (id: string) => { st.invalidated.push(id); },
}));

import { DELETE } from "./route";

const call = (id: string) =>
  DELETE(new Request(`https://x.test/api/team/members/${id}`, { method: "DELETE" }) as never,
    { params: Promise.resolve({ id }) });

beforeEach(() => {
  st.user = { id: ME }; st.me = { role: "owner", is_active: true }; st.rpcCalls = []; st.invalidated = []; st.adminUsed = false;
  st.result = { data: { removed: TARGET }, error: null };
});

describe("R-2477: Remove from this company", () => {
  it("forwards the session to remove_company_member and drops the removed login's cached role", async () => {
    const r = await call(TARGET);
    expect(r.status).toBe(200);
    expect(st.rpcCalls).toEqual([{ fn: "remove_company_member", args: { p_user_id: TARGET } }]);
    expect(st.invalidated).toEqual([TARGET]);
    expect(st.adminUsed).toBe(false);
  });

  it("signed out → 401, nothing called", async () => {
    st.user = null;
    const r = await call(TARGET);
    expect(r.status).toBe(401);
    expect(st.rpcCalls).toHaveLength(0);
  });

  it.each([
    [{ role: "sales", is_active: true }],
    [{ role: "owner", is_active: false }],
    [null],
  ])("not an active owner (%o) → 403 with a next step, nothing called", async (me) => {
    st.me = me;
    const r = await call(TARGET);
    expect(r.status).toBe(403);
    expect((await r.json() as { error: string }).error).toMatch(/Ask an owner/);
    expect(st.rpcCalls).toHaveLength(0);
  });

  it("not a uuid → 400, nothing called", async () => {
    const r = await call("not-a-uuid");
    expect(r.status).toBe(400);
    expect(st.rpcCalls).toHaveLength(0);
  });

  it.each([
    ["42501", 403, "You cannot remove yourself. Ask another owner of this company to do it."],
    ["P0002", 404, "That person is not a member of this company (they may have been removed already). Refresh the Team page."],
  ])("refusal %s → %i with the server's own words (next step kept)", async (code, status, message) => {
    st.result = { data: null, error: { code, message } };
    const r = await call(TARGET);
    expect(r.status).toBe(status);
    expect(await r.json()).toEqual({ error: message });
    expect(st.invalidated).toHaveLength(0);
  });

  it("an unexpected error → 500 without raw database text", async () => {
    st.result = { data: null, error: { code: "XX000", message: "relation tenant_memberships does not exist" } };
    const r = await call(TARGET);
    expect(r.status).toBe(500);
    const { error } = await r.json() as { error: string };
    expect(error).not.toMatch(/relation|tenant_memberships/);
    expect(error).toMatch(/Try again/);
  });
});
