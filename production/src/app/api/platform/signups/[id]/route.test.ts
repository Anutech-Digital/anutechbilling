/**
 * R-881 — DELETE /api/platform/signups/[id].
 *
 * Before (manager-pardeep 514efbdb, route.ts:14-61): the only gate was the email allowlist
 * (route.ts:22) — an UNVERIFIED account that signed up with an admin email passed it; no typed
 * confirmation reached the server; no audit; five separate deletes (route.ts:48-56) could stop
 * half-way; a workspace full of customers and invoices was wiped like an empty one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ADMIN_TENANT = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";

const st = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  target: null as Record<string, unknown> | null,
  counts: {} as Record<string, number | null>,
  ops: [] as string[],
  auditFails: false,
}));

vi.mock("@/lib/supabase/server", () => {
  const chain = (table: string) => {
    let op = "select";
    let head = false;
    const result = () => {
      if (op === "insert") return { data: null, error: table === "activity_log" && st.auditFails ? { message: "x" } : null };
      if (op === "delete") return { data: null, error: null };
      if (head) {
        const c = st.counts[table];
        return c === null ? { count: null, error: { message: "boom" } } : { count: c ?? 0, error: null };
      }
      if (table === "users") return { data: { tenant_id: ADMIN_TENANT }, error: null };
      if (table === "tenants") return { data: st.target, error: null };
      return { data: null, error: null };
    };
    const self: Record<string, unknown> = {};
    for (const m of ["eq", "limit"]) self[m] = () => self;
    self.select = (_c?: string, o?: { head?: boolean }) => { head = Boolean(o?.head); return self; };
    self.insert = (row: Record<string, unknown>) => { op = "insert"; st.ops.push(`${table}.insert:${String(row.label ?? "")}`); return self; };
    self.delete = () => { op = "delete"; st.ops.push(`${table}.delete`); return self; };
    self.maybeSingle = async () => result();
    self.single = async () => result();
    self.then = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res);
    return self;
  };
  const client = () => ({
    auth: { getUser: async () => ({ data: { user: st.user }, error: null }) },
    from: (t: string) => chain(t),
  });
  return { createClient: client, createAdminClient: client };
});

import { DELETE } from "./route";

const del = (body?: unknown) =>
  DELETE(
    new Request(`http://localhost:3001/api/platform/signups/${TARGET}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: TARGET }) },
  );

const deletes = () => st.ops.filter((o) => o.endsWith(".delete"));

beforeEach(() => {
  vi.stubEnv("PLATFORM_ADMIN_EMAILS", "pardeep@anutech.in");
  st.user = { id: "u1", email: "pardeep@anutech.in", email_confirmed_at: "2026-01-01T00:00:00Z" };
  st.target = { id: TARGET, name: "Empty Signup Co" };
  st.counts = {};
  st.ops = [];
  st.auditFails = false;
});
afterEach(() => vi.unstubAllEnvs());

describe("R-881 platform workspace DELETE fails closed", () => {
  it("an UNVERIFIED account using an admin email → 403, nothing deleted", async () => {
    st.user = { id: "u2", email: "pardeep@anutech.in", email_confirmed_at: null };
    const res = await del({ confirm: "Empty Signup Co" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/verify/);
    expect(deletes()).toEqual([]);
  });

  it("a non-admin → 403", async () => {
    st.user = { id: "u3", email: "someone@else.in", email_confirmed_at: "2026-01-01T00:00:00Z" };
    expect((await del({ confirm: "Empty Signup Co" })).status).toBe(403);
    expect(deletes()).toEqual([]);
  });

  it("no typed confirmation (the old request shape) → 400, nothing deleted", async () => {
    const res = await del();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('"Empty Signup Co"');
    expect(deletes()).toEqual([]);
  });

  it("a wrong typed name → 400", async () => {
    expect((await del({ confirm: "Empty Signup" })).status).toBe(400);
    expect(deletes()).toEqual([]);
  });

  it("a workspace with customers / invoices → 409 'has data', nothing deleted", async () => {
    st.counts = { customers: 3, invoices: 2 };
    const res = await del({ confirm: "Empty Signup Co" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/customers 3.*invoices 2/);
    expect(deletes()).toEqual([]);
  });

  it("a count that cannot be read → refused (fail closed)", async () => {
    st.counts = { payments: null };
    expect((await del({ confirm: "Empty Signup Co" })).status).toBe(503);
    expect(deletes()).toEqual([]);
  });

  it("the caller's own workspace → 400", async () => {
    st.target = { id: ADMIN_TENANT, name: "Mine" };
    expect((await del({ confirm: "Mine" })).status).toBe(400);
    expect(deletes()).toEqual([]);
  });

  it("audit cannot be written → refused, nothing deleted", async () => {
    st.auditFails = true;
    expect((await del({ confirm: "Empty Signup Co" })).status).toBe(503);
    expect(deletes()).toEqual([]);
  });

  it("verified admin + typed name + empty workspace → audit first, then ONE tenants delete", async () => {
    const res = await del({ confirm: "Empty Signup Co" });
    expect(res.status).toBe(200);
    expect(deletes()).toEqual(["tenants.delete"]);
    const auditIdx = st.ops.findIndex((o) => o.startsWith("activity_log.insert:") && o.includes("shuru"));
    expect(auditIdx).toBeGreaterThanOrEqual(0);
    expect(auditIdx).toBeLessThan(st.ops.indexOf("tenants.delete"));
  });
});
