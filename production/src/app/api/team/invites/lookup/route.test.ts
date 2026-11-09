/**
 * R-2517: POST /api/team/invites/lookup { token } — what the emailed invite link is for, for the
 * signed-in login. Pinned: session + token → company_invite_by_token only, nothing for a signed-out
 * caller or a malformed token, unknown states become not_found, the token is never echoed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const ME = "a0000000-0000-4000-8000-000000000001";
const TOKEN = "Abc_def-ghiJKLmnopQRstuVWXyz0123456789abcde";

const st = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  result: { data: null as unknown, error: null as null | { message: string; code?: string } },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: st.user } }) },
    rpc: async (fn: string, args: Record<string, unknown>) => { st.rpcCalls.push({ fn, args }); return st.result; },
  }),
  createAdminClient: () => { throw new Error("no admin client"); },
  createAdminClientFor: () => { throw new Error("no admin client"); },
}));

import { POST } from "./route";

const call = (body: unknown) =>
  POST(new Request("https://x.test/api/team/invites/lookup", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }) as never);

beforeEach(() => {
  st.user = { id: ME, email: "ravi@betatraders.test" }; st.rpcCalls = [];
  st.result = { data: { state: "open", company_name: "Excel Co", role: "sales", email: "ravi@betatraders.test", expires_at: "2026-11-16T00:00:00Z" }, error: null };
});

describe("R-2517: look up an emailed invite link", () => {
  it("open → company, role, address and who is signed in; token not echoed", async () => {
    const r = await call({ token: TOKEN });
    expect(r.status).toBe(200);
    expect(st.rpcCalls).toEqual([{ fn: "company_invite_by_token", args: { p_token: TOKEN } }]);
    const raw = await r.text();
    expect(JSON.parse(raw)).toEqual({
      state: "open", reason: null, companyName: "Excel Co", role: "sales", email: "ravi@betatraders.test",
      expiresAt: "2026-11-16T00:00:00Z", signedInAs: "ravi@betatraders.test",
    });
    expect(raw).not.toContain(TOKEN);
  });

  it("blocked → the database's reason is passed on", async () => {
    st.result = { data: { state: "blocked", reason: "This invite from Excel Co is no longer valid (the person who sent it is no longer an owner there). Ask them to invite you again.", company_name: "Excel Co" }, error: null };
    const b = await (await call({ token: TOKEN })).json() as { state: string; reason: string };
    expect(b.state).toBe("blocked");
    expect(b.reason).toMatch(/no longer an owner there/);
  });

  it("an unknown state from the database is treated as not_found", async () => {
    st.result = { data: { state: "weird" }, error: null };
    expect((await (await call({ token: TOKEN })).json() as { state: string }).state).toBe("not_found");
  });

  it("signed out → 401, bad token → 400, nothing called", async () => {
    st.user = null;
    expect((await call({ token: TOKEN })).status).toBe(401);
    st.user = { id: ME };
    expect((await call({ token: "x" })).status).toBe(400);
    expect(st.rpcCalls).toHaveLength(0);
  });

  it("two-step sign-in pending (42501) → 403 with the server's words; other errors → 500 without db text", async () => {
    st.result = { data: null, error: { code: "42501", message: "Finish two-step sign-in first: type the 6-digit code from your authenticator app, then open the invite link again." } };
    let r = await call({ token: TOKEN });
    expect(r.status).toBe(403);
    expect((await r.json() as { error: string }).error).toMatch(/two-step/);
    st.result = { data: null, error: { code: "XX000", message: "function company_invite_by_token does not exist" } };
    r = await call({ token: TOKEN });
    expect(r.status).toBe(500);
    expect((await r.json() as { error: string }).error).not.toMatch(/function|company_invite_by_token/);
  });
});
