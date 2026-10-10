/**
 * R-828 — approving a join request records the role the owner GAVE (granted_role),
 * and keeps the role the person ASKED for (requested_role) untouched. Reject leaves
 * granted_role empty. Runs the real route against a tiny in-memory admin client.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  sessionUser: null as null | { id: string },
}));

function query(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let op: "select" | "insert" | "update" = "select";
  let payload: Row | null = null;
  const rows = () => (db.tables[table] ??= []);
  const matched = () => rows().filter((r) => filters.every((f) => f(r)));
  const run = () => {
    if (op === "insert") { rows().push({ ...(payload as Row) }); return { data: payload, error: null }; }
    if (op === "update") { for (const r of matched()) Object.assign(r, payload); return { data: null, error: null }; }
    return { data: matched(), error: null };
  };
  const b = {
    select() { return b; },
    insert(p: Row) { op = "insert"; payload = p; return b; },
    update(p: Row) { op = "update"; payload = p; return b; },
    eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
    is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return b; },
    maybeSingle: async () => { const r = run(); const d = r.data as Row[] | Row | null; return { data: Array.isArray(d) ? d[0] ?? null : d, error: r.error }; },
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve(run()).then(res, rej); },
  };
  return b;
}
const admin = { from: (t: string) => query(t) };

vi.mock("@/lib/supabase/server", () => ({
  createAdminClientFor: () => admin,
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: db.sessionUser } }) } }),
}));

import { POST as decide } from "./route";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOINER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(() => {
  db.tables = {
    users: [{ id: OWNER, tenant_id: TENANT, role: "owner", email: "owner@example.in" }],
    join_requests: [{
      id: "jr-1", tenant_id: TENANT, auth_user_id: JOINER, email: "new@example.in", full_name: "New Person",
      requested_role: "support", status: "pending_approval", decided_at: null, decided_by: null, granted_role: null,
    }],
    team_invites: [],
    activity_log: [],
  };
  db.sessionUser = { id: OWNER };
});

const call = (body: unknown) =>
  decide(
    new NextRequest("https://app.example/api/team/join-requests/jr-1", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "jr-1" }) },
  );
const jr = () => db.tables.join_requests[0];

describe("R-828 join request keeps asked AND given role", () => {
  it("approve with role=sales → user is sales, row has granted_role sales, requested_role unchanged", async () => {
    const res = await call({ action: "approve", role: "sales" });
    expect(await res.json()).toMatchObject({ ok: true, action: "approved", role: "sales" });
    expect(db.tables.users.find((u) => u.id === JOINER)?.role).toBe("sales");
    expect(jr()).toMatchObject({ status: "approved", requested_role: "support", granted_role: "sales", decided_by: OWNER });
  });

  it("approve with a role that is not allowed falls back to support and records support", async () => {
    await call({ action: "approve", role: "superadmin" });
    expect(db.tables.users.find((u) => u.id === JOINER)?.role).toBe("support");
    expect(jr()).toMatchObject({ granted_role: "support", requested_role: "support" });
  });

  it("someone already in this workspace keeps their role, and the record says that role", async () => {
    db.tables.users.push({ id: JOINER, tenant_id: TENANT, role: "manager", email: "new@example.in" });
    await call({ action: "approve", role: "sales" });
    expect(db.tables.users.find((u) => u.id === JOINER)?.role).toBe("manager");
    expect(jr()).toMatchObject({ status: "approved", granted_role: "manager" });
  });

  it("reject → granted_role stays null", async () => {
    const res = await call({ action: "reject" });
    expect(await res.json()).toMatchObject({ ok: true, action: "rejected" });
    expect(jr()).toMatchObject({ status: "rejected", granted_role: null, requested_role: "support" });
    expect(db.tables.users.find((u) => u.id === JOINER)).toBeUndefined();
  });
});
