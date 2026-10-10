/**
 * /api/agent/feedback-queue: the AI worker's read-only list of "Queued for agent" reports.
 * Pinned: fails closed without a token, refuses a wrong one, reads only agent_queued rows,
 * and never returns the reporter's email, id or full name — R-539: only their lowercased first
 * name (`reporter`) and the workspace name, looked up in one users + one tenants read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const db = vi.hoisted(() => ({
  select: "" as string,
  filters: [] as Array<[string, unknown]>,
  writes: 0,
  rows: [] as Array<Record<string, unknown>>,
  error: null as null | { message: string },
  /** R-357/R-397: the first N reads fail on an unknown column (migration not applied yet). */
  missingColumns: 0,
  orders: [] as string[],
  /** R-539: the users / tenants lookups (one read each). */
  users: [] as Array<Record<string, unknown>>,
  tenants: [] as Array<Record<string, unknown>>,
  lookups: [] as Array<{ table: string; cols: string; ids: unknown[] }>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === "users" || table === "tenants") {
        const look = { table, cols: "", ids: [] as unknown[] };
        db.lookups.push(look);
        const l = {
          select(cols: string) { look.cols = cols; return l; },
          in(_col: string, ids: unknown[]) {
            look.ids = ids;
            const src = table === "users" ? db.users : db.tenants;
            return Promise.resolve({ data: src.filter((x) => ids.includes(x.id)), error: null });
          },
        };
        return l;
      }
      expect(table).toBe("feedback");
      const q = {
        select(cols: string) { db.select = cols; return q; },
        eq(col: string, v: unknown) { db.filters.push([col, v]); return q; },
        order(col: string) { db.orders.push(col); return q; },
        limit() {
          if (db.missingColumns > 0) {
            db.missingColumns--;
            return Promise.resolve({ data: null, error: { code: "42703", message: "column feedback.urgent_at does not exist" } });
          }
          return Promise.resolve({ data: db.error ? null : db.rows, error: db.error });
        },
        update() { db.writes++; return q; },
        delete() { db.writes++; return q; },
      };
      return q;
    },
  }),
}));

import { GET } from "./route";

const call = (token?: string) =>
  GET(new Request("https://example.invalid/api/agent/feedback-queue", token ? { headers: { authorization: `Bearer ${token}` } } : {}));
const ENV = { ...process.env };

beforeEach(() => {
  db.select = ""; db.filters = []; db.writes = 0; db.error = null; db.missingColumns = 0; db.orders = [];
  db.users = []; db.tenants = []; db.lookups = [];
  db.rows = [{ id: "f1", title: "Add browser automation to AI Help", directive: "Do X", reported_severity: "low" }];
  process.env.AGENT_QUEUE_TOKEN = "q-token";
});
afterEach(() => { process.env = { ...ENV }; });

describe("GET /api/agent/feedback-queue", () => {
  it("is closed when no token is configured", async () => {
    delete process.env.AGENT_QUEUE_TOKEN;
    const r = await call("q-token");
    expect(r.status).toBe(503);
    expect(db.select).toBe("");
  });

  it("refuses a missing or wrong token without reading anything", async () => {
    expect((await call()).status).toBe(401);
    expect((await call("CRON-or-guess")).status).toBe(401);
    expect(db.select).toBe("");
  });

  it("returns only queued reports, with what a card needs", async () => {
    const r = await call("q-token");
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.items).toEqual(db.rows.map((r) => ({ ...r, reporter: null, workspace: null })));
    expect(db.filters).toEqual([["status", "agent_queued"]]);
    expect(db.select).toContain("directive");
    expect(db.select).toContain("problem_summary");
  });

  it("never asks for the reporter's contact details or the report body, and never writes", async () => {
    await call("q-token");
    expect(db.select).not.toMatch(/reporter_|email|phone|body|ai_chat_summary/);
    expect(db.writes).toBe(0);
  });

  it("R-539: says who filed it — lowercased first name + workspace, never email / id / full name", async () => {
    db.rows = [
      { id: "f1", title: "A", reported_by: "u-abhi", tenant_id: "t-1" },
      { id: "f2", title: "B", reported_by: "u-abhi", tenant_id: "t-1" },
      { id: "f3", title: "C", reported_by: null, tenant_id: "t-2" },
    ];
    db.users = [{ id: "u-abhi", full_name: "  Abhishek Kumar Sharma", email: "abhishek@anutech.in", phone: "9999999999" }];
    db.tenants = [{ id: "t-1", name: "Anutech" }];
    const r = await call("q-token");
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.items).toEqual([
      { id: "f1", title: "A", reporter: "abhishek", workspace: "Anutech" },
      { id: "f2", title: "B", reporter: "abhishek", workspace: "Anutech" },
      { id: "f3", title: "C", reporter: null, workspace: null },
    ]);
    const json = JSON.stringify(body);
    expect(json).not.toContain("@");
    expect(json).not.toContain("anutech.in");
    expect(json).not.toContain("9999999999");
    expect(json).not.toContain("u-abhi");
    expect(json).not.toContain("Kumar");
    expect(json).not.toContain("reported_by");
    expect(json).not.toContain("tenant_id");
    // one read per table for the whole list (no N+1), asking only for id + name
    expect(db.lookups.map((l) => l.table).sort()).toEqual(["tenants", "users"]);
    const users = db.lookups.find((l) => l.table === "users")!;
    expect(users.ids).toEqual(["u-abhi"]);
    expect(users.cols).toBe("id, full_name");
    expect(db.lookups.find((l) => l.table === "tenants")!.ids).toEqual(["t-1", "t-2"]);
  });

  it("R-539: no letters in the first word → reporter null; no reporter ids → no users read", async () => {
    db.rows = [{ id: "f1", title: "A", reported_by: "u-x", tenant_id: null }];
    db.users = [{ id: "u-x", full_name: "123 Test" }];
    expect((await (await call("q-token")).json()).items).toEqual([{ id: "f1", title: "A", reporter: null, workspace: null }]);
    db.lookups = [];
    db.rows = [{ id: "f2", title: "B", reported_by: null, tenant_id: null }];
    expect((await (await call("q-token")).json()).items).toEqual([{ id: "f2", title: "B", reporter: null, workspace: null }]);
    expect(db.lookups).toEqual([]);
  });

  it("R-357: does not hand out a report an AI card already claimed", async () => {
    db.rows = [
      { id: "f1", title: "A", agent_claimed_at: null },
      { id: "f2", title: "B", agent_claimed_at: "2026-10-07T06:00:00Z" },
    ];
    const body = await (await call("q-token")).json();
    expect(body.items).toEqual([{ id: "f1", title: "A", reporter: null, workspace: null }]);
    expect(db.select).toContain("agent_claimed_at");
  });

  it("R-357: before the claim migration it falls back to the plain read", async () => {
    db.missingColumns = 2;
    const r = await call("q-token");
    expect(r.status).toBe(200);
    expect((await r.json()).items).toEqual(db.rows.map((r) => ({ ...r, reporter: null, workspace: null })));
    expect(db.select).not.toContain("agent_claimed_at");
    expect(db.select).toContain("reported_by");
  });

  it("says so on a read error instead of returning an empty queue", async () => {
    db.error = { message: "boom" };
    const r = await call("q-token");
    expect(r.status).toBe(500);
  });

  it("R-397: urgent reports come first (earliest marked first), with urgent: true", async () => {
    db.rows = [
      { id: "f1", title: "old", agent_claimed_at: null, urgent_at: null },
      { id: "f2", title: "later urgent", agent_claimed_at: null, urgent_at: "2026-10-07T09:00:00Z" },
      { id: "f3", title: "newer", agent_claimed_at: null, urgent_at: null },
      { id: "f4", title: "first urgent", agent_claimed_at: null, urgent_at: "2026-10-07T08:00:00Z" },
      { id: "f5", title: "claimed urgent", agent_claimed_at: "2026-10-07T08:30:00Z", urgent_at: "2026-10-07T07:00:00Z" },
    ];
    const body = await (await call("q-token")).json();
    expect(body.items).toEqual([
      { id: "f4", title: "first urgent", reporter: null, workspace: null, urgent: true },
      { id: "f2", title: "later urgent", reporter: null, workspace: null, urgent: true },
      { id: "f1", title: "old", reporter: null, workspace: null },
      { id: "f3", title: "newer", reporter: null, workspace: null },
    ]);
    expect(db.select).toContain("urgent_at");
    expect(db.orders).toEqual(["urgent_at", "dispatched_at"]);
  });

  it("R-397: before the urgent migration it falls back to the R-357 read — order unchanged", async () => {
    db.missingColumns = 1;
    db.rows = [
      { id: "f1", title: "A", agent_claimed_at: null },
      { id: "f2", title: "B", agent_claimed_at: null },
    ];
    const r = await call("q-token");
    expect(r.status).toBe(200);
    expect((await r.json()).items).toEqual([
      { id: "f1", title: "A", reporter: null, workspace: null },
      { id: "f2", title: "B", reporter: null, workspace: null },
    ]);
    expect(db.select).toContain("agent_claimed_at");
    expect(db.select).not.toContain("urgent_at");
  });
});
