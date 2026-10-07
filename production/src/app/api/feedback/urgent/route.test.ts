/**
 * R-397 — POST /api/feedback/urgent. Pinned: role gate (sales/support 403, no service role),
 * another workspace's report is 404 for a workspace user but allowed for the platform owner,
 * open → queued + urgent in one conditional write, queued → urgent only, un-urgent clears
 * only the flag, closed reports refuse, and before the migration it answers 409.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// R-051: who createAdminClientFor() was opened for (the audit log actor).
const actors = vi.hoisted(() => [] as string[]);
import type { NextRequest } from "next/server";

type Row = Record<string, unknown> & { id: string; tenant_id: string; status: string };
const db = vi.hoisted(() => ({
  user: { id: "u-owner", email: "owner@ws.test" } as { id: string; email: string } | null,
  me: { tenant_id: "t1", role: "owner" } as { tenant_id: string; role: string } | null,
  rows: [] as Row[],
  adminCreated: 0,
  patches: [] as Array<Record<string, unknown>>,
  updateFilters: [] as Array<Array<[string, string, unknown]>>,
  updateError: null as null | { code: string; message: string },
  afterRead: null as null | (() => void),
}));

vi.mock("@/lib/platform", () => ({ isPlatformAdmin: (e: string | null | undefined) => e === "boss@platform.test" }));

function adminFrom(table: string) {
  expect(table).toBe("feedback");
  let patch: Record<string, unknown> | null = null;
  const filters: Array<[string, string, unknown]> = [];
  const match = (r: Row) => filters.every(([, c, v]) => (r[c] ?? null) === v);
  const q = {
    select() {
      if (patch) {
        db.patches.push(patch);
        db.updateFilters.push(filters);
        if (db.updateError) return Promise.resolve({ data: null, error: db.updateError });
        const hit = db.rows.filter(match);
        for (const r of hit) Object.assign(r, patch);
        return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null });
      }
      return q;
    },
    update(v: Record<string, unknown>) { patch = v; return q; },
    eq(c: string, v: unknown) { filters.push(["eq", c, v]); return q; },
    is(c: string, v: unknown) { filters.push(["is", c, v]); return q; },
    maybeSingle() {
      const r = db.rows.find(match);
      const copy = r ? { ...r } : null;
      db.afterRead?.();
      return Promise.resolve({ data: copy, error: null });
    },
  };
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: db.user } }) },
    from: (table: string) => {
      expect(table).toBe("users");
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: db.me, error: null }) };
      return q;
    },
  }),
  createAdminClientFor: (actor: string) => { actors.push(actor); db.adminCreated++; return { from: adminFrom }; },
}));

import { POST } from "./route";

const OPEN = "11111111-1111-4111-8111-111111111111";
const QUEUED = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const FIXED = "44444444-4444-4444-8444-444444444444";
const call = (body: unknown) =>
  POST(new Request("https://example.invalid/api/feedback/urgent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest);
const find = (id: string) => db.rows.find((r) => r.id === id)!;

beforeEach(() => {
  actors.length = 0;
  db.user = { id: "u-owner", email: "owner@ws.test" };
  db.me = { tenant_id: "t1", role: "owner" };
  db.adminCreated = 0; db.patches = []; db.updateFilters = []; db.updateError = null; db.afterRead = null;
  db.rows = [
    { id: OPEN, tenant_id: "t1", status: "open", dispatched_at: null, urgent_at: null, urgent_by: null },
    { id: QUEUED, tenant_id: "t1", status: "agent_queued", dispatched_at: "2026-10-07T05:00:00Z", urgent_at: null, urgent_by: null, agent_card: "R-300" },
    { id: OTHER, tenant_id: "t2", status: "agent_queued", dispatched_at: "2026-10-07T05:00:00Z", urgent_at: null, urgent_by: null },
    { id: FIXED, tenant_id: "t1", status: "fixed", dispatched_at: null, urgent_at: null, urgent_by: null },
  ];
});

describe("POST /api/feedback/urgent — R-397", () => {
  it("401 when signed out", async () => {
    db.user = null;
    expect((await call({ id: OPEN, urgent: true })).status).toBe(401);
    expect(db.adminCreated).toBe(0);
  });

  it("403 for sales/support/billing — service role never created", async () => {
    for (const role of ["sales", "support", "billing", "accountant"]) {
      db.me = { tenant_id: "t1", role };
      const r = await call({ id: QUEUED, urgent: true });
      expect(r.status).toBe(403);
    }
    expect(db.adminCreated).toBe(0);
    expect(find(QUEUED).urgent_at).toBeNull();
  });

  it("403 when the users row is missing", async () => {
    db.me = null;
    expect((await call({ id: QUEUED, urgent: true })).status).toBe(403);
  });

  it("400 on a bad body", async () => {
    expect((await call({ id: "nope", urgent: true })).status).toBe(400);
    expect((await call({ id: OPEN })).status).toBe(400);
  });

  it("open → queued AND urgent in one conditional write (still open, same dispatched_at)", async () => {
    const r = await call({ id: OPEN, urgent: true });
    expect(r.status).toBe(200);
    expect(actors).toEqual(["u-owner"]); // R-051: audit log names the signed-in caller
    expect(await r.json()).toEqual({ ok: true, urgent: true, queued: true });
    const row = find(OPEN);
    expect(row.status).toBe("agent_queued");
    expect(row.dispatched_by).toBe("u-owner");
    expect(row.urgent_by).toBe("u-owner");
    expect(typeof row.urgent_at).toBe("string");
    expect(db.updateFilters[0]).toEqual([
      ["eq", "id", OPEN], ["eq", "tenant_id", "t1"], ["eq", "status", "open"], ["is", "dispatched_at", null],
    ]);
  });

  it("manager can mark a queued (claimed) report urgent — flag only, card kept", async () => {
    db.me = { tenant_id: "t1", role: "manager" };
    const r = await call({ id: QUEUED, urgent: true });
    expect(await r.json()).toEqual({ ok: true, urgent: true, queued: false });
    expect(Object.keys(db.patches[0]).sort()).toEqual(["updated_at", "urgent_at", "urgent_by"]);
    expect(find(QUEUED).agent_card).toBe("R-300");
    expect(find(QUEUED).dispatched_at).toBe("2026-10-07T05:00:00Z");
  });

  it("un-urgent clears only the flag and never un-queues", async () => {
    find(QUEUED).urgent_at = "2026-10-07T06:00:00Z";
    find(QUEUED).urgent_by = "u-owner";
    const r = await call({ id: QUEUED, urgent: false });
    expect(await r.json()).toEqual({ ok: true, urgent: false, queued: false });
    expect(find(QUEUED)).toMatchObject({ status: "agent_queued", urgent_at: null, urgent_by: null });
  });

  it("another workspace's report is 404 for a workspace owner, and nothing is written", async () => {
    const r = await call({ id: OTHER, urgent: true });
    expect(r.status).toBe(404);
    expect(db.patches).toHaveLength(0);
  });

  it("the platform owner may mark another workspace's report; the write is pinned to ITS tenant", async () => {
    db.user = { id: "u-boss", email: "boss@platform.test" };
    db.me = { tenant_id: "t1", role: "sales" }; // ignored for the platform owner
    const r = await call({ id: OTHER, urgent: true });
    expect(r.status).toBe(200);
    expect(actors).toEqual(["u-boss"]); // R-051: audit log names the platform owner, not the workspace
    expect(find(OTHER).urgent_by).toBe("u-boss");
    expect(db.updateFilters[0]).toContainEqual(["eq", "tenant_id", "t2"]);
  });

  it("a closed report cannot be made urgent", async () => {
    const r = await call({ id: FIXED, urgent: true });
    expect(r.status).toBe(409);
    expect(db.patches).toHaveLength(0);
  });

  it("lost race: the open report was queued a moment ago → marked urgent as queued", async () => {
    // The read sees it open; the auto-send queues it before our write lands.
    const row = find(OPEN);
    db.afterRead = () => { row.status = "agent_queued"; row.dispatched_at = "2026-10-07T07:00:00Z"; };
    const r = await call({ id: OPEN, urgent: true });
    expect(r.status).toBe(200);
    expect((await r.json()).urgent).toBe(true);
    expect(row.urgent_by).toBe("u-owner");
    expect(row.dispatched_at).toBe("2026-10-07T07:00:00Z");
    expect(db.patches).toHaveLength(2);
  });

  it("before the migration (no urgent_at column) → 409 naming the file, nothing written", async () => {
    for (const r of db.rows) { delete r.urgent_at; delete r.urgent_by; }
    const r = await call({ id: QUEUED, urgent: true });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toContain("20261007234000_feedback_urgent.sql");
    expect(db.patches).toHaveLength(0);
  });

  it("a missing-column error on the write also answers 409, not 500", async () => {
    db.updateError = { code: "42703", message: "column feedback.urgent_at does not exist" };
    expect((await call({ id: QUEUED, urgent: true })).status).toBe(409);
  });
});
