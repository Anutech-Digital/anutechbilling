/**
 * R-2469 (4 Nov 2026, staging): Team → Invite for an address held by ANOTHER workspace.
 * Pinned: the route asks release_stale_team_invite (session client — auth.uid() is the owner)
 * BEFORE it writes the invite;
 *   member_elsewhere → 409 with a next step, no invite written, no company named;
 *   released         → the invite is written and the email goes out (the stale one was cleared);
 *   in_use           → the insert still hits the unique index → 409 with a next step;
 *   rpc error        → old behaviour (the invite is attempted), never a 500 from the check.
 * Temp-password path: a login elsewhere → 409 that points to the plain invite.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const OWNER = "a0000000-0000-4000-8000-000000000001";

const st = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcResult: { data: "none" as unknown, error: null as null | { message: string } },
  otherInvite: false,
  inserts: [] as Array<Record<string, unknown>>,
  emails: [] as Array<{ to: string; text: string }>,
  loginTenant: null as string | null,
  rateOk: true,
  rateKeys: [] as string[],
}));

vi.mock("@/lib/security/rate-limit", () => ({
  rateLimitShared: async (key: string) => { st.rateKeys.push(key); return { ok: st.rateOk, retryAfterSec: 60, remaining: 1 }; },
}));

vi.mock("@/lib/email/send", () => ({
  sendEmail: async (e: { to: string; text: string }) => { st.emails.push(e); return { status: "stubbed" }; },
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
      /* 'released' means the DB deleted the other workspace's invite. */
      if (fn === "release_stale_team_invite" && st.rpcResult.data === "released") st.otherInvite = false;
      return st.rpcResult;
    },
    from: (table: string) => {
      if (table === "users") return chain(() => ({ data: { tenant_id: T1, role: "owner", is_active: true }, error: null }));
      if (table === "tenants") return chain(() => ({ data: { name: "Acme" }, error: null }));
      if (table === "team_invites") {
        return {
          insert(v: Record<string, unknown>) {
            st.inserts.push(v);
            return chain(() => st.otherInvite
              ? { data: null, error: { code: "23505", message: "duplicate" } }
              : { data: { token: "tok" }, error: null });
          },
          /* RLS hides the other workspace's row. */
          select: () => chain(() => ({ data: null, error: null })),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
  createAdminClientFor: () => ({
    from: () => {
      const q = {
        select() { return q; },
        eq() { return q; },
        async maybeSingle() {
          return { data: st.loginTenant ? { id: "x", tenant_id: st.loginTenant } : null, error: null };
        },
      };
      return q;
    },
  }),
}));

import { POST } from "./route";

const call = (body: unknown) =>
  POST(new Request("https://x.test/api/team/invite", {
    method: "POST",
    headers: { "content-type": "application/json", host: "x.test" },
    body: JSON.stringify(body),
  }) as never);

beforeEach(() => {
  st.rpcCalls = []; st.rpcResult = { data: "none", error: null }; st.otherInvite = false;
  st.inserts = []; st.emails = []; st.loginTenant = null; st.rateOk = true; st.rateKeys = [];
});

const EMAIL = "ravi@acme.test";

describe("R-2469: invite an address held by another workspace", () => {
  it("asks release_stale_team_invite first, with the cleaned address", async () => {
    await call({ email: "Ravi@Acme.test", role: "sales" });
    /* R-2477: the existing-login step (invite_existing_login) runs first; this mock answers it with
       an unknown value, so the R-2469 check follows. */
    expect(st.rpcCalls.find((c) => c.fn === "release_stale_team_invite")).toEqual({ fn: "release_stale_team_invite", args: { p_email: EMAIL } });
  });

  /* R-2477: a member elsewhere is now invited (route.r2477.test.ts). This mock answers every rpc
     with the same value, so prepare_invite_for_existing_login gets an unknown answer and the route
     keeps this refusal (e.g. the R-2477 migration not deployed yet). */
  it("member of another real company, membership step unavailable → 409 with a next step, nothing written, no company named", async () => {
    st.rpcResult = { data: "member_elsewhere", error: null };
    const r = await call({ email: EMAIL, role: "sales" });
    expect(r.status).toBe(409);
    const { error } = await r.json() as { error: string };
    expect(error).toMatch(/member of another company/i);
    expect(error).toMatch(/Next step/);
    expect(error).not.toMatch(/Other Co|Acme/);
    expect(st.inserts).toHaveLength(0);
    expect(st.emails).toHaveLength(0);
  });

  it("stale invite elsewhere was released → the invite is written and the email goes out", async () => {
    st.otherInvite = true;
    st.rpcResult = { data: "released", error: null };
    const r = await call({ email: EMAIL, role: "sales" });
    expect(r.status).toBe(200);
    expect(st.inserts).toHaveLength(1);
    expect(st.inserts[0]).toMatchObject({ tenant_id: T1, email: EMAIL, role: "sales" });
    expect(st.emails).toHaveLength(1);
  });

  it("live invite elsewhere → 409 with a next step (no dead end), no company named", async () => {
    st.otherInvite = true;
    st.rpcResult = { data: "in_use", error: null };
    const r = await call({ email: EMAIL, role: "sales" });
    expect(r.status).toBe(409);
    const { error } = await r.json() as { error: string };
    expect(error).toMatch(/Next step/);
    expect(error).toMatch(/expire/i);
    expect(error).not.toMatch(/They need to leave it/);
    expect(st.emails).toHaveLength(0);
  });

  it("the check failing (e.g. migration not deployed yet) never blocks a normal invite", async () => {
    st.rpcResult = { data: null, error: { message: "function does not exist" } };
    const r = await call({ email: EMAIL, role: "sales" });
    expect(r.status).toBe(200);
    expect(st.inserts).toHaveLength(1);
  });

  it("temp password for a login in another workspace → 409 pointing to the plain invite", async () => {
    st.loginTenant = T2;
    const r = await call({ email: EMAIL, role: "sales", tempPassword: "Kites-river-42" });
    expect(r.status).toBe(409);
    const { error } = await r.json() as { error: string };
    expect(error).toMatch(/Invite them without a temporary password/);
    expect(st.inserts).toHaveLength(0);
  });
});

describe("R-2469: the address check is capped per owner (not an unlimited existence probe)", () => {
  it("over the hourly cap → 429, nothing asked, nothing written", async () => {
    st.rateOk = false;
    const r = await call({ email: EMAIL, role: "sales" });
    expect(r.status).toBe(429);
    expect(st.rateKeys).toEqual([`team-invite-check:${OWNER}`]);
    expect(st.rpcCalls).toHaveLength(0);
    expect(st.inserts).toHaveLength(0);
  });
});
