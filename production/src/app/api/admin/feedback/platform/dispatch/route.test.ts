/**
 * R-366 — POST /api/admin/feedback/platform/dispatch: platform owner sends another
 * workspace's report to the AI queue. Pinned: 403 for anyone else (service role never
 * created), only open + never-dispatched rows are queued, a second press changes nothing,
 * the write is pinned to the row's OWN tenant (a tenant id in the body is ignored), and the
 * patch touches only the R-357 columns.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

type Row = { id: string; tenant_id: string; status: string; dispatched_at: string | null; dispatched_by?: string | null };
const db = vi.hoisted(() => ({
  email: "owner@platform.test" as string | null,
  rows: [] as Row[],
  adminCreated: 0,
  patches: [] as Array<Record<string, unknown>>,
  updateFilters: [] as Array<Array<[string, string, unknown]>>,
}));

vi.mock("@/lib/platform", () => ({ isPlatformAdmin: (e: string | null | undefined) => e === "owner@platform.test" }));

function adminFrom() {
  let patch: Record<string, unknown> | null = null;
  const filters: Array<[string, string, unknown]> = [];
  const match = (r: Row) =>
    filters.every(([op, c, v]) => {
      const val = (r as Record<string, unknown>)[c];
      return op === "is" ? val === v : val === v;
    });
  const q = {
    select() {
      if (patch) {
        db.patches.push(patch);
        db.updateFilters.push(filters);
        const hit = db.rows.filter(match);
        for (const r of hit) Object.assign(r, patch);
        return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null });
      }
      return q;
    },
    update(v: Record<string, unknown>) { patch = v; return q; },
    eq(c: string, v: unknown) { filters.push(["eq", c, v]); return q; },
    is(c: string, v: unknown) { filters.push(["is", c, v]); return q; },
    limit() {
      return Promise.resolve({ data: db.rows.filter(match).map((r) => ({ ...r })), error: null });
    },
  };
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: db.email === null ? null : { id: "caller-1", email: db.email } } }) },
  }),
  createAdminClient: () => { db.adminCreated++; return { from: adminFrom }; },
}));

import { POST } from "./route";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const call = (body: unknown) =>
  POST(new Request("https://example.invalid/api/admin/feedback/platform/dispatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest);

beforeEach(() => {
  db.email = "owner@platform.test";
  db.adminCreated = 0; db.patches = []; db.updateFilters = [];
  db.rows = [
    { id: A, tenant_id: "tenant-excel", status: "open", dispatched_at: null },
    { id: B, tenant_id: "tenant-delfos", status: "agent_queued", dispatched_at: "2026-10-07T05:00:00Z" },
    { id: C, tenant_id: "tenant-delfos", status: "fixed", dispatched_at: null },
  ];
});

describe("POST /api/admin/feedback/platform/dispatch — R-366", () => {
  it("403 for a signed-in user who is not the platform owner, before the service role exists", async () => {
    db.email = "abhishek@excel.test";
    const r = await call({ id: A });
    expect(r.status).toBe(403);
    expect(db.adminCreated).toBe(0);
    expect(db.rows[0].status).toBe("open");
  });

  it("401 when not signed in", async () => {
    db.email = null;
    expect((await call({ id: A })).status).toBe(401);
    expect(db.adminCreated).toBe(0);
  });

  it("queues an open row of another workspace, pinned to that row's own tenant", async () => {
    const r = await call({ id: A, tenant_id: "tenant-attacker" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ queued: [A], skipped: [] });
    expect(db.rows[0]).toMatchObject({ status: "agent_queued", dispatched_by: "caller-1" });
    expect(db.rows[0].dispatched_at).toEqual(expect.any(String));
    const f = db.updateFilters[0];
    expect(f).toContainEqual(["eq", "tenant_id", "tenant-excel"]);
    expect(f).toContainEqual(["eq", "status", "open"]);
    expect(f).toContainEqual(["is", "dispatched_at", null]);
    expect(Object.keys(db.patches[0]).sort()).toEqual(["dispatched_at", "dispatched_by", "status", "updated_at"]);
  });

  it("does not queue a row that is not open (queued / fixed): skipped, no write", async () => {
    const r1 = await call({ id: B });
    expect(await r1.json()).toEqual({ queued: [], skipped: [B] });
    const r2 = await call({ id: C });
    expect(await r2.json()).toEqual({ queued: [], skipped: [C] });
    expect(db.patches).toHaveLength(0);
    expect(db.rows[2].status).toBe("fixed");
  });

  it("is idempotent: a second press reports skipped and keeps the first dispatch", async () => {
    await call({ id: A });
    const first = db.rows[0].dispatched_at;
    const r = await call({ id: A });
    expect(await r.json()).toEqual({ queued: [], skipped: [A] });
    expect(db.rows[0].dispatched_at).toBe(first);
    expect(db.patches).toHaveLength(1);
  });

  it("send all: queues only open, never-dispatched rows", async () => {
    db.rows.push({ id: "44444444-4444-4444-8444-444444444444", tenant_id: "tenant-anutech", status: "open", dispatched_at: null });
    const r = await call({ all: true });
    const json = await r.json();
    expect(json.queued.sort()).toEqual([A, "44444444-4444-4444-8444-444444444444"].sort());
    expect(db.rows.find((x) => x.id === B)?.dispatched_at).toBe("2026-10-07T05:00:00Z");
    expect(db.rows.find((x) => x.id === C)?.status).toBe("fixed");
  });

  it("400 for a bad body, 404 for an unknown id", async () => {
    expect((await call({ tenant_id: "x" })).status).toBe(400);
    expect((await call({ id: "55555555-5555-4555-8555-555555555555" })).status).toBe(404);
  });
});
