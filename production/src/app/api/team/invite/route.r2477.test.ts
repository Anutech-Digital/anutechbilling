/**
 * R-2477 (R-2471 slice 3 + independent review): Team → Invite for a login that already works in
 * ANOTHER company. Pinned:
 *   invite_existing_login FIRST (session client, cleaned address, the role); release_stale_team_invite
 *   only when the answer is not 'invited' / 'already_member':
 *     'invited'        → NO team_invites row; the answer says existingLogin; the email has no signup
 *                        link; R-2517: it carries /invites/accept#token=… whose sha256 is the
 *                        p_token_hash sent to invite_existing_login — the token is in the email only
 *                        (never in the answer to the owner's screen);
 *     'already_member' → 409 "already a member of your company" with a next step, nothing written;
 *     'no_company' / 'not_found' → the plain invite (team_invites row + signup link);
 *     54000            → 429;
 *     error            → for a member of another company the R-2469 refusal stays.
 *   No other company is ever named.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";

const T1 = "11111111-1111-4111-8111-111111111111";
const OWNER = "a0000000-0000-4000-8000-000000000001";

const st = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  held: "member_elsewhere" as unknown,
  ex: { data: "invited" as unknown, error: null as null | { message: string; code?: string } },
  inserts: [] as Array<Record<string, unknown>>,
  emails: [] as Array<{ to: string; text: string; subject: string; route?: unknown; logTenantId?: string; kind?: string }>,
  emailStatus: "sent" as string,
  emailError: null as string | null,
  deletes: [] as Array<Array<[string, string]>>,
}));

vi.mock("@/lib/security/rate-limit", () => ({
  rateLimitShared: async () => ({ ok: true, retryAfterSec: 60, remaining: 1 }),
}));

vi.mock("@/lib/messaging", () => ({
  sendInternalEmail: async (e: { to: string; text: string; subject: string; route?: unknown; logTenantId?: string; kind?: string }) => { st.emails.push(e); return { status: st.emailStatus, errorMessage: st.emailError }; },
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
      if (table === "membership_invites") {
        return {
          delete() {
            const eqs: Array<[string, string]> = [];
            st.deletes.push(eqs);
            const q = { eq(c: string, v: string) { eqs.push([c, v]); return q; }, then: (res: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(res) };
            return q;
          },
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
  st.inserts = []; st.emails = []; st.emailStatus = "sent"; st.emailError = null; st.deletes = [];
});

const EMAIL = "ravi@betatraders.test";

describe("R-2477: invite a login that works in another company", () => {
  it("invited → no team_invites row, existingLogin answer, email asks them to accept (no signup link)", async () => {
    const r = await call({ email: "Ravi@BetaTraders.test", role: "sales" });
    expect(r.status).toBe(200);
    /* review: the membership invite comes FIRST, and the R-2469 clean-up (which may delete another
       workspace's stale team_invites row) never runs for it */
    expect(st.rpcCalls).toEqual([{ fn: "invite_existing_login", args: { p_email: EMAIL, p_role: "sales", p_token_hash: expect.stringMatching(/^[0-9a-f]{64}$/) } }]);
    expect(st.inserts).toHaveLength(0);
    const raw = await r.text();
    const body = JSON.parse(raw) as { ok: boolean; existingLogin?: boolean };
    expect(body.existingLogin).toBe(true);
    expect(st.emails).toHaveLength(1);
    expect(st.emails[0].text).not.toMatch(/signup\?invite=/);
    expect(st.emails[0].text).toMatch(/you keep your current company/i);
    expect(st.emails[0].text).toMatch(/press Accept/i);
    expect(st.emails[0].text).toMatch(/Nothing changes until you accept/i);
    /* R-2517: the emailed link's token hashes to what the database stored; the owner's screen never gets it */
    const token = /\/invites\/accept#token=([A-Za-z0-9_-]+)/.exec(st.emails[0].text)?.[1];
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(st.emails[0].text).toMatch(/https?:\/\/[^\s/]+\/invites\/accept#token=/);
    expect(createHash("sha256").update(token!).digest("hex")).toBe(st.rpcCalls[0].args.p_token_hash);
    expect(raw).not.toContain(token!);
    expect(raw).not.toContain(String(st.rpcCalls[0].args.p_token_hash));
  });

  it("R-2517: the link email goes through the platform sender, never the inviting company's own mail route", async () => {
    await call({ email: EMAIL, role: "sales" });
    expect(st.emails[0].route).toBeUndefined();
  });

  it.each(["failed", "stubbed"])("R-2517: email %s → invite withdrawn, 502 with the next step (never 'they open the link')", async (status) => {
    st.emailStatus = status;
    const r = await call({ email: EMAIL, role: "sales" });
    expect(r.status).toBe(502);
    const { error } = await r.json() as { error: string };
    expect(error).toMatch(/could not be sent, so the invite was not saved/);
    expect(error).toMatch(/Next step/);
    expect(st.deletes).toEqual([[["tenant_id", T1], ["email", EMAIL]]]);
  });

  it("R-2696: the link email is logged under the inviting company (email_log row) with kind team_invite", async () => {
    await call({ email: EMAIL, role: "sales" });
    expect(st.emails[0]).toMatchObject({ logTenantId: T1, kind: "team_invite" });
    expect(st.emails[0].route).toBeUndefined();
  });

  it("R-2696: the 502 names the provider's reason, with addresses in it masked", async () => {
    st.emailStatus = "failed";
    st.emailError = 'Resend 403: {"statusCode":403,"message":"You can only send testing emails to your own email address (owner@anutech.in). To send emails to other recipients, please verify a domain at resend.com/domains","name":"validation_error"}';
    const r = await call({ email: EMAIL, role: "sales" });
    expect(r.status).toBe(502);
    const { error } = await r.json() as { error: string };
    expect(error).toMatch(/Reason: Resend 403 — You can only send testing emails/);
    expect(error).toMatch(/verify a domain/);
    expect(error).not.toContain("owner@anutech.in");
    expect(error).toContain("o***@anutech.in");
    expect(error).toMatch(/Next step/);
  });

  it("R-2696: a stubbed send says why (staging allowlist / no mail sender)", async () => {
    st.emailStatus = "stubbed";
    st.emailError = "not sent — staging-allowlist (staging mails only the team)";
    const r = await call({ email: EMAIL, role: "sales" });
    const { error } = await r.json() as { error: string };
    expect(error).toMatch(/Reason: not sent — staging-allowlist/);
    st.emailError = null;
    const r2 = await call({ email: EMAIL, role: "sales" });
    const { error: e2 } = await r2.json() as { error: string };
    expect(e2).toMatch(/Reason: no mail sender is set up/);
  });

  it("the plain invite still goes through the company's own mail route", async () => {
    st.ex = { data: "plain", error: null };
    st.held = "none";
    st.emailStatus = "stubbed";
    const r = await call({ email: EMAIL, role: "sales" });
    expect(r.status).toBe(200);
    expect(st.emails[0].route).toEqual({ tenantId: T1 });
    expect(st.deletes).toEqual([]);
  });

  it("R-2517: every invite gets a fresh link token", async () => {
    await call({ email: EMAIL, role: "sales" });
    await call({ email: EMAIL, role: "sales" });
    const [a, b] = st.rpcCalls.filter((c) => c.fn === "invite_existing_login").map((c) => c.args.p_token_hash);
    expect(a).not.toBe(b);
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

  it.each(["plain", "no_company", "not_found"])("%s → the plain invite (team_invites row + signup link)", async (outcome) => {
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

  it("plain for a member_elsewhere address (a login removed from every company) is NOT refused — plain invite + Claim", async () => {
    st.ex = { data: "plain", error: null };
    st.held = "member_elsewhere";
    const r = await call({ email: EMAIL, role: "sales" });
    expect(r.status).toBe(200);
    expect(st.inserts).toHaveLength(1);
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
