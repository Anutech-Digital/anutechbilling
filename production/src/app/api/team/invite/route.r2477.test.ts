/**
 * R-2477 (R-2471 slice 3 + independent review): Team → Invite for a login that already works in
 * ANOTHER company. Pinned:
 *   invite_existing_login FIRST (session client, cleaned address, the role); release_stale_team_invite
 *   only when the answer is not 'invited' / 'already_member':
 *     'invited'        → NO team_invites row; the answer says existingLogin; the email has no signup
 *                        link and tells them to press Accept on the invite in their app;
 *     'already_member' → 409 "already a member of your company" with a next step, nothing written;
 *     'no_company' / 'not_found' → the plain invite (team_invites row + signup link);
 *     54000            → 429;
 *     error            → for a member of another company the R-2469 refusal stays.
 *   No other company is ever named.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const T1 = "11111111-1111-4111-8111-111111111111";
const OWNER = "a0000000-0000-4000-8000-000000000001";

const st = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  held: "member_elsewhere" as unknown,
  ex: { data: "invited" as unknown, error: null as null | { message: string; code?: string } },
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
      if (fn === "release_stale_team_invite") return { data: st.held, error: null };
      if (fn === "invite_existing_login") return st.ex;
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
  st.rpcCalls = []; st.held = "member_elsewhere"; st.ex = { data: "invited", error: null };
  st.inserts = []; st.emails = [];
});

const EMAIL = "ravi@betatraders.test";

describe("R-2477: invite a login that works in another company", () => {
  it("invited → no team_invites row, existingLogin answer, email asks them to accept (no signup link)", async () => {
    const r = await call({ email: "Ravi@BetaTraders.test", role: "sales" });
    expect(r.status).toBe(200);
    /* review: the membership invite comes FIRST, and the R-2469 clean-up (which may delete another
       workspace's stale team_invites row) never runs for it */
    expect(st.rpcCalls).toEqual([{ fn: "invite_existing_login", args: { p_email: EMAIL, p_role: "sales" } }]);
    expect(st.inserts).toHaveLength(0);
    const body = await r.json() as { ok: boolean; existingLogin?: boolean };
    expect(body.existingLogin).toBe(true);
    expect(st.emails).toHaveLength(1);
    expect(st.emails[0].text).not.toMatch(/signup\?invite=/);
    expect(st.emails[0].text).toMatch(/you keep your current company/i);
    expect(st.emails[0].text).toMatch(/press Accept/i);
    expect(st.emails[0].text).toMatch(/Nothing changes until you accept/i);
  });

  it("already a member here → 409 with a next step, nothing written, no email", async () => {
    st.ex = { data: "already_member", error: null };
    const r = await call({ email: EMAIL, role: "sales" });
    expect(r.status).toBe(409);
    const { error } = await r.json() as { error: string };
    expect(error).toMatch(/already a member of your company/i);
    expect(error).toMatch(/Next step/);
    expect(st.inserts).toHaveLength(0);
    expect(st.emails).toHaveLength(0);
  });

  it.each(["no_company", "not_found"])("%s → the plain invite (team_invites row + signup link)", async (outcome) => {
    st.ex = { data: outcome, error: null };
    st.held = "none";
    const r = await call({ email: EMAIL, role: "sales" });
    expect(r.status).toBe(200);
    expect(st.inserts).toEqual([expect.objectContaining({ tenant_id: T1, email: EMAIL, role: "sales" })]);
    expect(st.emails[0].text).toMatch(/signup\?invite=tok-123/);
    expect((await r.json() as { existingLogin?: boolean }).existingLogin).toBeUndefined();
  });

  it("over its hourly cap → 429, nothing written", async () => {
    st.ex = { data: null, error: { code: "54000", message: "Too many invites in the last hour." } };
    const r = await call({ email: EMAIL, role: "sales" });
    expect(r.status).toBe(429);
    expect(st.inserts).toHaveLength(0);
  });

  it("the step failing keeps the R-2469 refusal for a member of another company (never a half-done invite)", async () => {
    st.ex = { data: null, error: { message: "function does not exist" } };
    const r = await call({ email: EMAIL, role: "sales" });
    expect(r.status).toBe(409);
    const { error } = await r.json() as { error: string };
    expect(error).toMatch(/member of another company/i);
    expect(error).not.toMatch(/function does not exist/);
    expect(st.inserts).toHaveLength(0);
  });
});
