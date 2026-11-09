/**
 * R-2517: POST /api/team/invites/accept { token } — the login accepts an invite from another
 * company with the token from the invite email (proof of the mailbox).
 * Pinned: no privilege of its own (session + token → accept_company_invite_by_token), no token /
 * a bad token never reaches the database, refusals pass through with their next step, raw database
 * text is never shown, the token is never echoed, and the gateway role cache is dropped only when
 * the accept switched this login's company.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const ME = "a0000000-0000-4000-8000-000000000001";
// a link token of the right shape (base64url, 43 chars) — test data, built so it reads as no secret
const TOKEN = "t".repeat(40) + "_-9";

const st = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
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

const call = (body: unknown) =>
  POST(new Request("https://x.test/api/team/invites/accept", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }) as never);

beforeEach(() => {
  st.user = { id: ME }; st.rpcCalls = []; st.invalidated = [];
  st.result = { data: { tenant_id: "t2", company_name: "Beta Traders", role: "sales", selected: false }, error: null };
});

describe("R-2517: accept an invite from another company with the emailed token", () => {
  it("forwards the session + token to accept_company_invite_by_token; answers company / role / selected", async () => {
    const r = await call({ token: TOKEN });
    expect(r.status).toBe(200);
    expect(st.rpcCalls).toEqual([{ fn: "accept_company_invite_by_token", args: { p_token: TOKEN } }]);
    const raw = await r.text();
    expect(JSON.parse(raw)).toEqual({ ok: true, tenantId: "t2", companyName: "Beta Traders", role: "sales", selected: false });
    expect(raw).not.toContain(TOKEN);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(st.invalidated).toEqual([]);
  });

  it("an accept that switched company drops this login's cached role", async () => {
    st.result = { data: { company_name: "Beta Traders", role: "sales", selected: true }, error: null };
    await call({ token: TOKEN });
    expect(st.invalidated).toEqual([ME]);
  });

  it("signed out → 401; no / malformed token → 400 with a next step; nothing called", async () => {
    st.user = null;
    expect((await call({ token: TOKEN })).status).toBe(401);
    st.user = { id: ME };
    for (const body of [{}, { token: "" }, { token: "short" }, { token: "has spaces in it but is long enough to pass" }, { token: 42 }, null]) {
      const r = await call(body);
      expect(r.status).toBe(400);
      expect((await r.json() as { error: string }).error).toMatch(/Open the link from the invite email again/);
    }
    expect(st.rpcCalls).toHaveLength(0);
  });

  it.each([
    ["P0002", 404, "This invite link is not valid any more (the company sent a newer invite or withdrew it). Open the newest invite email, or ask the company to invite you again."],
    ["42501", 403, "This invite link was sent to another email address. Sign out, sign in with the address the email was sent to, then open the link again."],
    ["42501", 403, "This invite link was already used. If you joined Beta Traders, pick it from the company switcher in the top bar."],
  ])("refusal %s → %i with the server's own words", async (code, status, message) => {
    st.result = { data: null, error: { code, message } };
    const r = await call({ token: TOKEN });
    expect(r.status).toBe(status);
    expect(await r.json()).toEqual({ error: message });
  });

  it("an unexpected error → 500 without raw database text", async () => {
    st.result = { data: null, error: { code: "XX000", message: "relation membership_invites does not exist" } };
    const r = await call({ token: TOKEN });
    expect(r.status).toBe(500);
    expect((await r.json() as { error: string }).error).not.toMatch(/relation|membership_invites/);
  });
});
