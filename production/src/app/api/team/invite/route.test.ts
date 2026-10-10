/**
 * R-534: POST /api/team/invite with an optional temporary password.
 * Pinned: plain invites unchanged (no service role, no login made); non-owner refused;
 * owner role / short password / rate limit / existing login refused BEFORE the invite is
 * written; with a password: audit first (no password in it), auth user with the must_change
 * flag, users row in the CALLER's tenant with the invited role, invite marked accepted,
 * password returned once (no-store) and never in the email.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const T1 = "11111111-1111-4111-8111-111111111111";
const OWNER = "a0000000-0000-4000-8000-000000000001";
const SALES = "a0000000-0000-4000-8000-000000000002";
const NEW_ID = "b0000000-0000-4000-8000-000000000009";

const st = vi.hoisted(() => ({
  sessionUserId: null as string | null,
  callerRole: "owner",
  existingLogins: new Set<string>(),
  invites: [] as Array<Record<string, unknown>>,
  inviteUpdates: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  auditUpdates: [] as Array<Record<string, unknown>>,
  createdAuth: [] as Array<Record<string, unknown>>,
  deletedAuth: [] as string[],
  userRows: [] as Array<Record<string, unknown>>,
  emails: [] as Array<{ to: string; text: string }>,
  actors: [] as string[],
  order: [] as string[],
  rateOk: true,
  createFails: null as string | null,
}));

vi.mock("@/lib/security/rate-limit", () => ({
  rateLimitShared: async () => ({ ok: st.rateOk, retryAfterSec: 60, remaining: 0 }),
}));

vi.mock("@/lib/email/send", () => ({
  sendEmail: async (e: { to: string; text: string }) => { st.emails.push(e); return { status: "stubbed" }; },
}));

/** A chainable query that resolves to `result` however it is awaited/ended. */
function chain(result: () => unknown, onUpdate?: (v: Record<string, unknown>) => void) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "order"]) q[m] = () => q;
  q.update = (v: Record<string, unknown>) => { onUpdate?.(v); return q; };
  q.single = async () => result();
  q.maybeSingle = async () => result();
  q.then = (res: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(res);
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: st.sessionUserId ? { id: st.sessionUserId } : null } }) },
    from: (table: string) => {
      if (table === "users") return chain(() => ({ data: { tenant_id: T1, role: st.callerRole }, error: null }));
      if (table === "tenants") return chain(() => ({ data: { name: "Acme" }, error: null }));
      if (table === "team_invites") {
        return {
          insert(v: Record<string, unknown>) {
            st.order.push("invite");
            st.invites.push(v);
            return chain(() => ({ data: { token: "tok" }, error: null }));
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
  createAdminClientFor: (actor: string) => {
    st.actors.push(actor);
    return {
      auth: {
        admin: {
          createUser: async (attrs: Record<string, unknown>) => {
            st.order.push("auth");
            st.createdAuth.push(attrs);
            return st.createFails
              ? { data: { user: null }, error: { message: st.createFails } }
              : { data: { user: { id: NEW_ID } }, error: null };
          },
          deleteUser: async (id: string) => { st.deletedAuth.push(id); return { error: null }; },
        },
      },
      from: (table: string) => {
        if (table === "users") {
          const eqs: Record<string, unknown> = {};
          const q = {
            select() { return q; },
            eq(c: string, v: unknown) { eqs[c] = v; return q; },
            async maybeSingle() {
              return { data: st.existingLogins.has(String(eqs.email)) ? { id: SALES } : null, error: null };
            },
            async insert(v: Record<string, unknown>) { st.order.push("users"); st.userRows.push(v); return { error: null }; },
          };
          return q;
        }
        if (table === "activity_log") {
          return {
            insert(v: Record<string, unknown>) {
              st.order.push("audit");
              st.audits.push(v);
              return chain(() => ({ data: { id: 77 }, error: null }));
            },
            update(v: Record<string, unknown>) { st.auditUpdates.push(v); return chain(() => ({ error: null })); },
          };
        }
        if (table === "team_invites") return chain(() => ({ error: null }), (v) => st.inviteUpdates.push(v));
        throw new Error(`unexpected admin table ${table}`);
      },
    };
  },
}));

import { POST } from "./route";

const call = (body: unknown) =>
  POST(new Request("https://x.test/api/team/invite", {
    method: "POST",
    headers: { "content-type": "application/json", host: "x.test" },
    body: JSON.stringify(body),
  }) as never);

const PW = "Kites-river-42";

beforeEach(() => {
  st.sessionUserId = OWNER; st.callerRole = "owner"; st.existingLogins = new Set();
  st.invites = []; st.inviteUpdates = []; st.audits = []; st.auditUpdates = [];
  st.createdAuth = []; st.deletedAuth = []; st.userRows = []; st.emails = [];
  st.actors = []; st.order = []; st.rateOk = true; st.createFails = null;
});

const noLogin = () => {
  expect(st.createdAuth).toHaveLength(0);
  expect(st.userRows).toHaveLength(0);
  expect(st.audits).toHaveLength(0);
};

describe("POST /api/team/invite — temporary password (R-534)", () => {
  it("a plain invite is unchanged: no service role, no login, no password back", async () => {
    const r = await call({ email: "new@acme.test", role: "sales" });
    expect(r.status).toBe(200);
    const json = await r.json() as Record<string, unknown>;
    expect(json.password).toBeUndefined();
    expect(st.actors).toEqual([]);
    expect(st.invites).toHaveLength(1);
    noLogin();
    expect(st.emails[0].text).toContain("/signup?invite=tok");
  });

  it("refuses a non-owner (with or without a password)", async () => {
    st.callerRole = "manager";
    expect((await call({ email: "new@acme.test", role: "sales", tempPassword: PW })).status).toBe(403);
    expect(st.invites).toHaveLength(0);
    noLogin();
  });

  it("refuses a temporary password for an owner invite, before the invite is written", async () => {
    expect((await call({ email: "new@acme.test", role: "owner", tempPassword: PW })).status).toBe(422);
    expect(st.invites).toHaveLength(0);
    noLogin();
  });

  it("refuses a short password (422) and the hourly limit (429), before the invite", async () => {
    expect((await call({ email: "new@acme.test", role: "sales", tempPassword: "Short9" })).status).toBe(422);
    st.rateOk = false;
    const r = await call({ email: "new@acme.test", role: "sales", tempPassword: PW });
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("60");
    expect(st.invites).toHaveLength(0);
    noLogin();
  });

  it("refuses an email that already has a login (409)", async () => {
    st.existingLogins.add("sales@acme.test");
    expect((await call({ email: "sales@acme.test", role: "sales", tempPassword: PW })).status).toBe(409);
    expect(st.invites).toHaveLength(0);
    noLogin();
  });

  it("creates the login in the caller's tenant: audit first, must_change flag, password once, not in email", async () => {
    const r = await call({ email: "Ravi.Kumar@acme.test", role: "billing", tempPassword: PW });
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    const json = await r.json() as Record<string, unknown>;
    expect(json).toMatchObject({ memberCreated: true, password: PW, mustChange: true });

    expect(st.actors.every((a) => a === OWNER)).toBe(true);
    expect(st.order).toEqual(["invite", "audit", "auth", "users"]);

    expect(st.createdAuth[0]).toMatchObject({ email: "ravi.kumar@acme.test", password: PW, email_confirm: true });
    expect(st.createdAuth[0].app_metadata).toMatchObject({ must_change_password: true, temp_password_set_by: OWNER });

    expect(st.userRows[0]).toMatchObject({ id: NEW_ID, tenant_id: T1, role: "billing", email: "ravi.kumar@acme.test", full_name: "Ravi Kumar" });

    expect(st.audits[0]).toMatchObject({ tenant_id: T1, user_id: OWNER, action: "temp_password_set", entity: "user" });
    expect(JSON.stringify([st.audits, st.auditUpdates])).not.toContain(PW);
    expect(st.auditUpdates).toContainEqual({ entity_id: NEW_ID });
    expect(st.inviteUpdates[0]).toHaveProperty("accepted_at");

    expect(st.emails[0].text).not.toContain(PW);
    expect(st.emails[0].text).not.toContain("/signup?invite=");
  });

  it("an auth 'already registered' answer is a 409, audit marked failed, no users row", async () => {
    st.createFails = "A user with this email address has already been registered";
    const r = await call({ email: "new@acme.test", role: "sales", tempPassword: PW });
    expect(r.status).toBe(409);
    expect(JSON.stringify(await r.json())).not.toContain(PW);
    expect(st.userRows).toHaveLength(0);
    expect(st.auditUpdates[0]).toMatchObject({ action: "temp_password_failed" });
  });
});
