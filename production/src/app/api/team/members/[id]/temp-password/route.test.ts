/**
 * R-391: POST /api/team/members/[id]/temp-password.
 * Pinned: 401 signed out, 403 non-owner / cross-tenant / owner target / self, 429 rate limit,
 * password only in the one response (not in the audit row, not logged), must_change flag set
 * via app_metadata, audit written BEFORE the change and the change skipped if it cannot be.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// R-051: who createAdminClientFor() was opened for (the audit log actor).
const actors = vi.hoisted(() => [] as string[]);

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const OWNER  = "a0000000-0000-4000-8000-000000000001";
const SALES  = "a0000000-0000-4000-8000-000000000002";
const OWNER2 = "a0000000-0000-4000-8000-000000000003";
const OTHER  = "a0000000-0000-4000-8000-000000000004";

type UserRow = { id: string; role: string; tenant_id: string; email: string };
const USERS: Record<string, UserRow> = {
  [OWNER]:  { id: OWNER,  role: "owner", tenant_id: T1, email: "owner@t1.test" },
  [SALES]:  { id: SALES,  role: "sales", tenant_id: T1, email: "sales@t1.test" },
  [OWNER2]: { id: OWNER2, role: "owner", tenant_id: T1, email: "owner2@t1.test" },
  [OTHER]:  { id: OTHER,  role: "sales", tenant_id: T2, email: "other@t2.test" },
};

const st = vi.hoisted(() => ({
  sessionUserId: null as string | null,
  inserts: [] as Array<Record<string, unknown>>,
  auditUpdates: [] as Array<Record<string, unknown>>,
  authUpdates: [] as Array<{ id: string; attrs: Record<string, unknown> }>,
  auditFails: false,
  authFails: false,
  rateOk: true,
  order: [] as string[],
}));

vi.mock("@/lib/security/rate-limit", () => ({
  rateLimitShared: async () => ({ ok: st.rateOk, retryAfterSec: 60, remaining: 0 }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: st.sessionUserId ? { id: st.sessionUserId } : null } }) },
  }),
  createAdminClientFor: (actor: string) => (actors.push(actor), {
    auth: {
      admin: {
        updateUserById: async (id: string, attrs: Record<string, unknown>) => {
          st.order.push("auth");
          st.authUpdates.push({ id, attrs });
          return st.authFails ? { data: null, error: { message: "boom" } } : { data: { user: { id } }, error: null };
        },
      },
    },
    from: (table: string) => {
      if (table === "users") {
        const eqs: Record<string, unknown> = {};
        const q = {
          select() { return q; },
          eq(c: string, v: unknown) { eqs[c] = v; return q; },
          async maybeSingle() {
            const row = USERS[String(eqs.id)];
            if (!row) return { data: null, error: null };
            if (eqs.tenant_id !== undefined && row.tenant_id !== eqs.tenant_id) return { data: null, error: null };
            return { data: row, error: null };
          },
        };
        return q;
      }
      if (table === "activity_log") {
        return {
          insert(v: Record<string, unknown>) {
            st.order.push("audit");
            st.inserts.push(v);
            return {
              select: () => ({
                single: async () => st.auditFails
                  ? { data: null, error: { message: "nope" } }
                  : { data: { id: 77 }, error: null },
              }),
            };
          },
          update(v: Record<string, unknown>) {
            st.auditUpdates.push(v);
            return { eq: async () => ({ error: null }) };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

import { POST } from "./route";

const call = (target: string, body: unknown = {}) =>
  POST(
    new Request(`https://x.test/api/team/members/${target}/temp-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: target }) },
  );

const spies: Array<ReturnType<typeof vi.spyOn>> = [];
beforeEach(() => {
  actors.length = 0;
  st.sessionUserId = OWNER;
  st.inserts = []; st.auditUpdates = []; st.authUpdates = []; st.order = [];
  st.auditFails = false; st.authFails = false; st.rateOk = true;
  spies.push(
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "info").mockImplementation(() => {}),
  );
});
afterEach(() => { spies.splice(0).forEach((s) => s.mockRestore()); });

const nothingChanged = () => {
  expect(st.authUpdates).toHaveLength(0);
  expect(st.inserts).toHaveLength(0);
};

describe("POST /api/team/members/[id]/temp-password", () => {
  it("401 when signed out", async () => {
    st.sessionUserId = null;
    expect((await call(SALES)).status).toBe(401);
    nothingChanged();
  });

  it("403 for a non-owner caller", async () => {
    st.sessionUserId = SALES;
    const r = await call(OWNER);
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toMatch(/Only the workspace owner/);
    nothingChanged();
  });

  it("403 for a member of another workspace (looked up inside the caller's tenant only)", async () => {
    expect((await call(OTHER)).status).toBe(403);
    expect((await call("not-a-uuid")).status).toBe(403);
    nothingChanged();
  });

  it("403 for another owner and for yourself", async () => {
    expect((await call(OWNER2)).status).toBe(403);
    expect((await call(OWNER)).status).toBe(403);
    nothingChanged();
  });

  it("429 when the owner is over the hourly limit", async () => {
    st.rateOk = false;
    const r = await call(SALES);
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("60");
    nothingChanged();
  });

  it("422 for a typed password under 8 characters", async () => {
    expect((await call(SALES, { password: "Sh0rt9p" })).status).toBe(422);
    nothingChanged();
  });

  it("sets a generated password + must_change flag, audits first, returns it ONCE, logs nothing", async () => {
    const r = await call(SALES);
    expect(r.status).toBe(200);
    expect(actors).toEqual([OWNER]); // R-051: auth + users writes name the owner who reset it
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    const json = await r.json() as { password: string; mustChange: boolean };
    expect(json.password).toMatch(/^[A-Za-z2-9]{16}$/);
    expect(json.mustChange).toBe(true);

    expect(st.order).toEqual(["audit", "auth"]);
    expect(st.authUpdates).toHaveLength(1);
    expect(st.authUpdates[0].id).toBe(SALES);
    expect(st.authUpdates[0].attrs.password).toBe(json.password);
    expect(st.authUpdates[0].attrs.app_metadata).toMatchObject({ must_change_password: true, temp_password_set_by: OWNER });

    expect(st.inserts).toHaveLength(1);
    expect(st.inserts[0]).toMatchObject({ tenant_id: T1, user_id: OWNER, action: "temp_password_set", entity: "user", entity_id: SALES });
    expect(JSON.stringify(st.inserts[0])).not.toContain(json.password);

    for (const s of spies) {
      for (const args of s.mock.calls) expect(JSON.stringify(args)).not.toContain(json.password);
    }
  });

  it("uses an owner-typed password of 8+ characters", async () => {
    const r = await call(SALES, { password: "Kites-river-42" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { password: string }).password).toBe("Kites-river-42");
    expect(st.authUpdates[0].attrs.password).toBe("Kites-river-42");
  });

  it("does not change the password when the audit row cannot be written", async () => {
    st.auditFails = true;
    expect((await call(SALES)).status).toBe(500);
    expect(st.authUpdates).toHaveLength(0);
  });

  it("marks the audit row failed (still without the password) when the auth update fails", async () => {
    st.authFails = true;
    const r = await call(SALES, { password: "Kites-river-42" });
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain("Kites-river-42");
    expect(st.auditUpdates[0]).toMatchObject({ action: "temp_password_failed" });
    expect(JSON.stringify(st.auditUpdates)).not.toContain("Kites-river-42");
  });
});
