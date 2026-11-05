/**
 * R-2477 (R-2471 slice 3): Team → Invite for a login that already works in ANOTHER company.
 * Pinned (the owner's real path — company B invites a manager of company A):
 *   release_stale_team_invite → 'member_elsewhere', then prepare_invite_for_existing_login
 *   (session client, cleaned address):
 *     'ready'          → the invite is written, the answer says existingLogin, the email has NO
 *                        signup link (they have a login) and says they keep their company;
 *     'already_member' → 409 "already a member of your company" with a next step, nothing written;
 *     error / unknown  → the R-2469 refusal stays (e.g. migration not deployed yet).
 *   No other company is ever named.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const T1 = "11111111-1111-4111-8111-111111111111";
const OWNER = "a0000000-0000-4000-8000-000000000001";

const st = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  prep: { data: "ready" as unknown, error: null as null | { message: string } },
  inserts: [] as Array<Record<string, unknown>>,
  emails: [] as Array<{ to: string; text: string; subject: string }>,
}));

vi.mock("@/lib/security/rate-limit", () => ({
  rateLimitShared: async () => ({ ok: true, retryAfterSec: 60, remaining: 1 }),
}));

vi.mock("@/lib/messaging", () => ({
  sendInternalEmail: async (e: { to: string; text: string; subject: string }) => { st.emails.push(e); return { status: "stubbed" }; },
}));

function chain(result: () => unknown) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "order", "update"]) q[m] = () => q;
  q.single = async () => result();
  q.maybeSingle = async () => result();
  q.then = (res: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(res);
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: OWNER } } }) },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      st.rpcCalls.push({ fn, args });
      if (fn === "release_stale_team_invite") return { data: "member_elsewhere", error: null };
      if (fn === "prepare_invite_for_existing_login") return st.prep;
      throw new Error(`unexpected rpc ${fn}`);
    },
    from: (table: string) => {
      if (table === "users") return chain(() => ({ data: { tenant_id: T1, role: "owner", is_active: true }, error: null }));
      if (table === "tenants") return chain(() => ({ data: { name: "Beta Traders" }, error: null }));
      if (table === "team_invites") {
        return {
          insert(v: Record<string, unknown>) {
            st.inserts.push(v);
            return chain(() => ({ data: { token: "tok-123" }, error: null }));
          },
          select: () => chain(() => ({ data: null, error: null })),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
  createAdminClientFor: () => { throw new Error("no admin client on this path"); },
}));

import { POST } from "./route";

const call = (body: unknown) =>
  POST(new Request("https://x.test/api/team/invite", {
    method: "POST",
    headers: { "content-type": "application/json", host: "x.test" },
    body: JSON.stringify(body),
  }) as never);

beforeEach(() => {
  st.rpcCalls = []; st.prep = { data: "ready", error: null }; st.inserts = []; st.emails = [];
});

const EMAIL = "ravi@betatraders.test";

describe("R-2477: invite a login that works in another company", () => {
  it("ready → invite written, existingLogin answer, email without a signup link that says they keep their company", async () => {
    const r = await call({ email: "Ravi@BetaTraders.test", role: "sales" });
    expect(r.status).toBe(200);
    expect(st.rpcCalls.map((c) => c.fn)).toEqual(["release_stale_team_invite", "prepare_invite_for_existing_login"]);
    expect(st.rpcCalls[1].args).toEqual({ p_email: EMAIL });
    expect(st.inserts).toEqual([expect.objectContaining({ tenant_id: T1, email: EMAIL, role: "sales" })]);
    const body = await r.json() as { ok: boolean; existingLogin?: boolean };
    expect(body.existingLogin).toBe(true);
    expect(st.emails).toHaveLength(1);
    expect(st.emails[0].text).not.toMatch(/signup\?invite=/);
    expect(st.emails[0].text).toMatch(/you keep your current company/i);
    expect(st.emails[0].text).toMatch(/switch between your companies/i);
  });

  it("already a member here → 409 with a next step, nothing written, no email", async () => {
    st.prep = { data: "already_member", error: null };
    const r = await call({ email: EMAIL, role: "sales" });
    expect(r.status).toBe(409);
    const { error } = await r.json() as { error: string };
    expect(error).toMatch(/already a member of your company/i);
    expect(error).toMatch(/Next step/);
    expect(st.inserts).toHaveLength(0);
    expect(st.emails).toHaveLength(0);
  });

  it("the membership step failing keeps the R-2469 refusal (never a half-done invite)", async () => {
    st.prep = { data: null, error: { message: "function does not exist" } };
    const r = await call({ email: EMAIL, role: "sales" });
    expect(r.status).toBe(409);
    const { error } = await r.json() as { error: string };
    expect(error).toMatch(/member of another company/i);
    expect(error).not.toMatch(/function does not exist/);
    expect(st.inserts).toHaveLength(0);
  });

  it("an unknown answer also keeps the refusal", async () => {
    st.prep = { data: "something-else", error: null };
    const r = await call({ email: EMAIL, role: "sales" });
    expect(r.status).toBe(409);
    expect(st.inserts).toHaveLength(0);
  });
});
