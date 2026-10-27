/**
 * POST /api/auth/signup — R-736 (no account enumeration, server password rules) and R-733
 * (invite expiry, atomic accept through accept_team_invite).
 *
 * Before (manager-pardeep 4f1a604a): route.ts:139 returned GoTrue's `authError.message`
 * ("A user with this email address has already been registered"); the password reached
 * createUser with only GoTrue's 6-character floor; an invited signup inserted the users row
 * and then, separately, marked the invite used — and no invite ever expired.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";

const st = vi.hoisted(() => ({
  invite: null as Record<string, unknown> | null,       // row for the token lookup
  pending: null as Record<string, unknown> | null,      // row for the by-email lookup
  createErr: null as { message: string; code?: string; status?: number } | null,
  rpcErr: null as { message: string } | null,
  insertErr: {} as Record<string, { message: string; code?: string }>, // per table
  calls: [] as string[],
  inserted: {} as Record<string, Record<string, unknown>>, // R-1927: last insert payload per table
}));

vi.mock("@/lib/security/turnstile-guard", () => ({ turnstileRefusal: async () => null }));
vi.mock("@/lib/app-url", () => ({ trustedOrigin: () => "http://localhost:3001" }));
vi.mock("@/lib/auth/tenant-match", () => ({ findVerifiedDomainTenant: async () => null }));
vi.mock("@/lib/auth/email-verification", () => ({ startEmailVerification: async () => ({ sent: true }) }));
vi.mock("@/lib/auth/domain", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/domain")>()),
  emailDomain: () => "",
}));

vi.mock("@/lib/supabase/server", () => {
  const chain = (table: string) => {
    let byToken = false;
    const self: Record<string, unknown> = {};
    self.select = () => self;
    self.eq = (col: string) => { if (col === "token") byToken = true; return self; };
    self.is = () => self;
    self.update = () => { st.calls.push(`${table}.update`); return self; };
    self.delete = () => { st.calls.push(`${table}.delete`); return self; };
    self.insert = (row: Record<string, unknown>) => { st.inserted[table] = row; st.calls.push(`${table}.insert`); return Promise.resolve({ error: st.insertErr[table] ?? null }); };
    self.maybeSingle = async () => ({
      data: table === "team_invites" ? (byToken ? st.invite : st.pending) : null,
      error: null,
    });
    return self;
  };
  const admin = {
    from: (t: string) => chain(t),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      st.calls.push(`rpc:${fn}:${String(args.p_token ?? "")}`);
      return { data: st.rpcErr ? null : [{ tenant_id: TENANT, role: "sales" }], error: st.rpcErr };
    },
    auth: {
      admin: {
        createUser: async () => {
          st.calls.push("createUser");
          return st.createErr
            ? { data: { user: null }, error: st.createErr }
            : { data: { user: { id: "new-user" } }, error: null };
        },
        deleteUser: async () => { st.calls.push("deleteUser"); return { error: null }; },
      },
    },
  };
  return { createAdminClient: () => admin };
});

import { POST } from "./route";

const post = (body: Record<string, unknown>) =>
  POST(new Request("http://localhost:3001/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as never);

const base = { email: "Someone@Example.in", password: "Str0ng-pass-123!", fullName: "Some One", companyName: "Some Co" };
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

beforeEach(() => {
  st.invite = null;
  st.pending = null;
  st.createErr = null;
  st.rpcErr = null;
  st.insertErr = {};
  st.calls = [];
  st.inserted = {};
});

/* R-1137 follow-up (23 Oct 2026): the tenant / users insert failures and the catch-all sent
   raw database text to the browser ("Tenant creation failed: duplicate key … tenants_pkey"). */
describe("signup never sends raw database text to the browser", () => {
  const RAW = 'duplicate key value violates unique constraint "tenants_pkey"';
  it("a tenant insert failure is a fixed sentence with a code, and the login is rolled back", async () => {
    st.insertErr = { tenants: { message: RAW, code: "23505" } };
    const res = await post(base);
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toMatch(/tenants_pkey|duplicate key|Tenant creation failed/);
    expect(body.code).toBe("signup_company_failed");
    expect(body.error).toMatch(/try again/i);
    expect(st.calls).toContain("deleteUser");
  });
  it("a users insert failure is a fixed sentence too", async () => {
    st.insertErr = { users: { message: 'null value in column "tenant_id" of relation "users"' } };
    const res = await post(base);
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toMatch(/relation|column|User record creation failed/);
    expect(body.code).toBe("signup_user_failed");
  });
  it("an unexpected throw is a fixed sentence, not the exception text", async () => {
    const res = await POST(new Request("http://localhost:3001/api/auth/signup", { method: "POST", body: "{not json" }) as never);
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toMatch(/JSON|Unexpected token|position/i);
    expect(body.code).toBe("signup_failed");
  });
});

describe("R-736: signup does not reveal whether an email is registered", () => {
  it("an already-registered email gets exactly the new-company answer", async () => {
    const fresh = await (await post(base)).json();

    st.calls = [];
    st.createErr = { message: "A user with this email address has already been registered", code: "email_exists", status: 422 };
    const res = await post(base);
    const taken = await res.json();

    expect(res.status).toBe(200);
    expect(taken).toEqual(fresh);
    expect(JSON.stringify(taken)).not.toMatch(/already|registered/i);
    expect(fresh).not.toHaveProperty("userId");
    expect(fresh).not.toHaveProperty("tenantId");
  });

  it("an older GoTrue without the code is recognised by its message too", async () => {
    st.createErr = { message: "User already registered" };
    const res = await post(base);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("created");
  });

  it("any other provider error is generic, with a next step, and never echoes the raw text", async () => {
    st.createErr = { message: "internal GoTrue detail xyz", status: 500 };
    const res = await post(base);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).not.toContain("xyz");
    expect(body.error).toMatch(/try again/i);
  });
});

describe("R-736: the server applies the app's password rules", () => {
  it.each([["123456"], ["password"], ["short1"], [" Str0ng-pass-123!"], ["ResellerOS@2026"]])(
    "refuses %j before any account is created",
    async (password) => {
      const res = await post({ ...base, password });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.field).toBe("password");
      expect(body.error.length).toBeGreaterThan(10);
      expect(st.calls).not.toContain("createUser");
    },
  );
});

describe("R-733: invite expiry and the atomic accept", () => {
  it("a valid token joins through accept_team_invite — no separate users insert / invite update", async () => {
    st.invite = { tenant_id: TENANT, role: "sales", expires_at: FUTURE };
    const res = await post({ ...base, inviteToken: TOKEN });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("joined");
    expect(st.calls).toContain(`rpc:accept_team_invite:${TOKEN}`);
    expect(st.calls).not.toContain("users.insert");
    expect(st.calls).not.toContain("team_invites.update");
  });

  it("an expired token is refused with a next step BEFORE any account exists", async () => {
    st.invite = { tenant_id: TENANT, role: "sales", expires_at: PAST };
    const res = await post({ ...base, inviteToken: TOKEN });
    expect(res.status).toBe(410);
    expect((await res.json()).error).toMatch(/expired.*invite you again/i);
    expect(st.calls).not.toContain("createUser");
  });

  it("an expired invite for the email (no token) is refused too, not turned into a new company", async () => {
    st.pending = { id: "inv", expires_at: PAST };
    const res = await post(base);
    expect(res.status).toBe(410);
    expect(st.calls).not.toContain("createUser");
  });

  it("the second use of a link (lost the race) → 'already used', and the login it made is removed", async () => {
    st.invite = { tenant_id: TENANT, role: "sales", expires_at: FUTURE };
    st.rpcErr = { message: "This invite has already been used. Sign in with that email instead" };
    const res = await post({ ...base, inviteToken: TOKEN });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already been used/);
    expect(st.calls).toContain("deleteUser");
  });
});

/* R-1927 (G-ONBOARD OB-6): the GSTIN typed at signup did not set the company's state
   (the tenants insert had only name / gstin / email), so the wizard asked again for a state
   the owner had already given us. A checksum-valid GSTIN now saves state + state_code. */
describe("R-1927: the GSTIN typed at signup sets the company's state", () => {
  it("a valid Delhi GSTIN saves state Delhi / 07 on the new company", async () => {
    const res = await post({ ...base, gstin: "07ABDCA0298H1ZP" });
    expect(res.status).toBe(200);
    expect(st.inserted.tenants).toMatchObject({ gstin: "07ABDCA0298H1ZP", state: "Delhi", state_code: "07" });
  });
  it("lower-case / spaced GSTIN still gives the state", async () => {
    await post({ ...base, gstin: " 07abdca0298h1zp " });
    expect(st.inserted.tenants).toMatchObject({ state: "Delhi", state_code: "07" });
  });
  it("no GSTIN or a wrong one → no guessed state", async () => {
    await post({ ...base });
    expect(st.inserted.tenants.state_code ?? null).toBeNull();
    expect(st.inserted.tenants.state ?? null).toBeNull();
    await post({ ...base, gstin: "07ABDCA0298H1ZX" });
    expect(st.inserted.tenants.state_code ?? null).toBeNull();
  });
});
