/**
 * R-609: DELETE /api/attendance/ingest-key turns the biometric machine key off.
 * Pinned: 401 signed out, 403 non-owner, an owner only ever clears HIS OWN tenant's key,
 * the audit row is written first and never carries the key, a failed audit changes nothing,
 * GET ?status=1 tells any member whether a key exists without ever returning it, and
 * /api/attendance/punch refuses the old key once it is off (and refuses a missing key).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const OWNER1 = "a0000000-0000-4000-8000-000000000001";
const HR1    = "a0000000-0000-4000-8000-000000000002";
const OWNER2 = "a0000000-0000-4000-8000-000000000003";
const KEY1 = "k1-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY2 = "k2-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const USERS: Record<string, { tenant_id: string; role: string }> = {
  [OWNER1]: { tenant_id: T1, role: "owner" },
  [HR1]:    { tenant_id: T1, role: "hr" },
  [OWNER2]: { tenant_id: T2, role: "owner" },
};

const st = vi.hoisted(() => ({
  sessionUserId: null as string | null,
  settings: {} as Record<string, { ingest_key: string | null }>,
  audits: [] as Array<Record<string, unknown>>,
  auditUpdates: [] as Array<Record<string, unknown>>,
  order: [] as string[],
  auditFails: false,
  updateFails: false,
}));

function settingsTable() {
  const eqs: Record<string, unknown> = {};
  let patch: Record<string, unknown> | null = null;
  const q = {
    select() { return q; },
    eq(c: string, v: unknown) { eqs[c] = v; return q; },
    update(v: Record<string, unknown>) { patch = v; return q; },
    upsert(v: { tenant_id: string; ingest_key: string }) {
      st.settings[v.tenant_id] = { ingest_key: v.ingest_key };
      return Promise.resolve({ error: null });
    },
    async maybeSingle() {
      if (eqs.tenant_id !== undefined) {
        const row = st.settings[String(eqs.tenant_id)];
        return { data: row ? { ingest_key: row.ingest_key } : null, error: null };
      }
      if (eqs.ingest_key !== undefined) {
        const hit = Object.entries(st.settings).find(([, r]) => r.ingest_key !== null && r.ingest_key === eqs.ingest_key);
        return { data: hit ? { tenant_id: hit[0] } : null, error: null };
      }
      return { data: null, error: null };
    },
    then(resolve: (r: { error: unknown }) => void) {
      // awaited update(...).eq("tenant_id", t)
      if (patch) {
        st.order.push("update");
        if (st.updateFails) return resolve({ error: { message: "boom" } });
        const row = st.settings[String(eqs.tenant_id)];
        if (row) Object.assign(row, { ingest_key: patch.ingest_key as string | null });
      }
      resolve({ error: null });
    },
  };
  return q;
}

function emptyList() {
  const q = {
    select() { return q; },
    eq() { return q; },
    not() { return Promise.resolve({ data: [], error: null }); },
  };
  return q;
}

function adminFrom(table: string) {
  if (table === "attendance_settings") return settingsTable();
  if (table === "employees") return emptyList();
  if (table === "activity_log") {
    return {
      insert(v: Record<string, unknown>) {
        st.order.push("audit");
        if (!st.auditFails) st.audits.push(v);
        return {
          select: () => ({
            single: async () => st.auditFails ? { data: null, error: { message: "nope" } } : { data: { id: 9 }, error: null },
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
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: st.sessionUserId ? { id: st.sessionUserId } : null } }) },
    from: (table: string) => {
      if (table !== "users") throw new Error(`unexpected table ${table}`);
      let id = "";
      const q = {
        select() { return q; },
        eq(_c: string, v: string) { id = v; return q; },
        async single() { return { data: USERS[id] ?? null, error: null }; },
      };
      return q;
    },
  }),
  createAdminClientFor: () => ({ from: adminFrom }),
  createAdminClient: () => ({ from: adminFrom }),
}));

import { DELETE, GET } from "./route";
import { POST as PUNCH } from "../punch/route";

const get = (qs = "") => GET(new Request(`https://x.test/api/attendance/ingest-key${qs}`) as never);
const punch = (key: string | null) =>
  PUNCH(new Request("https://x.test/api/attendance/punch", {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "x-ingest-key": key } : {}) },
    body: JSON.stringify({ punches: [{ biometric_id: "1", timestamp: "2026-10-10T04:00:00Z" }] }),
  }) as never);

beforeEach(() => {
  st.sessionUserId = OWNER1;
  st.settings = { [T1]: { ingest_key: KEY1 }, [T2]: { ingest_key: KEY2 } };
  st.audits = []; st.auditUpdates = []; st.order = [];
  st.auditFails = false; st.updateFails = false;
});

describe("DELETE /api/attendance/ingest-key (R-609)", () => {
  it("401 when signed out — nothing changes", async () => {
    st.sessionUserId = null;
    expect((await DELETE()).status).toBe(401);
    expect(st.settings[T1].ingest_key).toBe(KEY1);
    expect(st.audits).toHaveLength(0);
  });

  it("403 for a non-owner member of the same tenant — nothing changes", async () => {
    st.sessionUserId = HR1;
    const r = await DELETE();
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toMatch(/Only the owner/);
    expect(st.settings[T1].ingest_key).toBe(KEY1);
    expect(st.audits).toHaveLength(0);
  });

  it("owner clears his own key, audit first, and the audit never holds the key", async () => {
    const r = await DELETE();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, hasKey: false });
    expect(st.settings[T1].ingest_key).toBeNull();
    expect(st.order).toEqual(["audit", "update"]);
    expect(st.audits).toHaveLength(1);
    expect(st.audits[0]).toMatchObject({ tenant_id: T1, user_id: OWNER1, action: "attendance_ingest_key_off" });
    expect(JSON.stringify(st.audits[0])).not.toContain(KEY1);
  });

  it("cross-tenant: another tenant's owner cannot touch this tenant's key", async () => {
    st.sessionUserId = OWNER2;
    expect((await DELETE()).status).toBe(200);
    expect(st.settings[T2].ingest_key).toBeNull();
    expect(st.settings[T1].ingest_key).toBe(KEY1);
    expect(st.audits[0]).toMatchObject({ tenant_id: T2 });
  });

  it("already off → ok, no audit, no write", async () => {
    st.settings[T1].ingest_key = null;
    const r = await DELETE();
    expect(await r.json()).toMatchObject({ ok: true, hasKey: false, alreadyOff: true });
    expect(st.order).toEqual([]);
  });

  it("audit cannot be written → key stays, 500 with a next step", async () => {
    st.auditFails = true;
    const r = await DELETE();
    expect(r.status).toBe(500);
    expect(((await r.json()) as { error: string }).error).toMatch(/not turned off\. Try again/);
    expect(st.settings[T1].ingest_key).toBe(KEY1);
  });

  it("save fails → audit row marked failed, response says the old key still works", async () => {
    st.updateFails = true;
    const r = await DELETE();
    expect(r.status).toBe(500);
    expect(((await r.json()) as { error: string }).error).toMatch(/old key still works/);
    expect(st.auditUpdates[0]).toMatchObject({ action: "attendance_ingest_key_off_failed" });
  });
});

describe("GET /api/attendance/ingest-key", () => {
  it("?status=1 tells a non-owner member whether a key exists, never the key", async () => {
    st.sessionUserId = HR1;
    const r = await get("?status=1");
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({ hasKey: true });
    expect(JSON.stringify(body)).not.toContain(KEY1);
  });

  it("the key itself stays owner-only", async () => {
    st.sessionUserId = HR1;
    expect((await get()).status).toBe(403);
    st.sessionUserId = OWNER1;
    expect(await (await get()).json()).toMatchObject({ key: KEY1, hasKey: true });
  });

  it("status reads Off after the owner turns it off", async () => {
    await DELETE();
    expect(await (await get("?status=1")).json()).toEqual({ hasKey: false });
  });
});

describe("POST /api/attendance/punch with no key", () => {
  it("accepts the key while it exists, refuses the same key once it is off", async () => {
    expect((await punch(KEY1)).status).toBe(200);
    await DELETE();
    const r = await punch(KEY1);
    expect(r.status).toBe(401);
    // the other tenant's machine is untouched
    expect((await punch(KEY2)).status).toBe(200);
  });

  it("refuses a request with no key header", async () => {
    expect((await punch(null)).status).toBe(401);
  });

  it("refuses any key when no tenant has one", async () => {
    st.settings = { [T1]: { ingest_key: null }, [T2]: { ingest_key: null } };
    expect((await punch(KEY1)).status).toBe(401);
    expect((await punch("")).status).toBe(401);
  });
});
