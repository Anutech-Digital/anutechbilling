/**
 * R-2477 review: POST /api/team/invites/:id/accept — the login accepts an invite itself.
 * Pinned: no privilege of its own (session → accept_company_invite), refusals pass through with
 * their next step, raw database text is never shown, and the gateway role cache is dropped only
 * when the accept switched this login's company.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const ME = "a0000000-0000-4000-8000-000000000001";
const INV = "c0000000-0000-4000-8000-000000000003";

const st = vi.hoisted(() => ({
  user: null as null | { id: string },
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  result: { data: null as unknown, error: null as null | { message: string; code?: string } },
  invalidated: [] as string[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: st.user } }) },
    rpc: async (fn: string, args: Record<string, unknown>) => { st.rpcCalls.push({ fn, args }); return st.result; },
  }),
  createAdminClient: () => { throw new Error("no admin client"); },
  createAdminClientFor: () => { throw new Error("no admin client"); },
}));
vi.mock("@/server/postgrest/gateway-limits", () => ({
  invalidateGatewayRole: (id: string) => { st.invalidated.push(id); },
}));

import { POST } from "./route";

const call = (id: string) =>
  POST(new Request(`https://x.test/api/team/invites/${id}/accept`, { method: "POST" }) as never,
    { params: Promise.resolve({ id }) });

beforeEach(() => {
  st.user = { id: ME }; st.rpcCalls = []; st.invalidated = [];
  st.result = { data: { company_name: "Beta Traders", role: "sales", selected: false }, error: null };
});

describe("R-2477: accept an invite from another company", () => {
  it("forwards the session to accept_company_invite and answers company / role / selected", async () => {
    const r = await call(INV);
    expect(r.status).toBe(200);
    expect(st.rpcCalls).toEqual([{ fn: "accept_company_invite", args: { p_invite_id: INV } }]);
    expect(await r.json()).toEqual({ ok: true, companyName: "Beta Traders", role: "sales", selected: false });
    expect(st.invalidated).toEqual([]);
  });

  it("an accept that switched company drops this login's cached role", async () => {
    st.result = { data: { company_name: "Beta Traders", role: "sales", selected: true }, error: null };
    await call(INV);
    expect(st.invalidated).toEqual([ME]);
  });

  it("signed out → 401; not a uuid → 400; nothing called", async () => {
    st.user = null;
    expect((await call(INV)).status).toBe(401);
    st.user = { id: ME };
    expect((await call("nope")).status).toBe(400);
    expect(st.rpcCalls).toHaveLength(0);
  });

  it.each([
    ["P0002", 404, "This invite is not for you, or it was withdrawn. Ask the company to invite you again."],
    ["42501", 403, "This invite from Beta Traders has expired. Ask them to invite you again."],
  ])("refusal %s → %i with the server's own words", async (code, status, message) => {
    st.result = { data: null, error: { code, message } };
    const r = await call(INV);
    expect(r.status).toBe(status);
    expect(await r.json()).toEqual({ error: message });
  });

  it("an unexpected error → 500 without raw database text", async () => {
    st.result = { data: null, error: { code: "XX000", message: "relation membership_invites does not exist" } };
    const r = await call(INV);
    expect(r.status).toBe(500);
    expect((await r.json() as { error: string }).error).not.toMatch(/relation|membership_invites/);
  });
});
