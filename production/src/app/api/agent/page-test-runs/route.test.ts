/**
 * /api/agent/page-test-runs (R-352): the browser test session reports its result.
 * Pinned: closed without a token, refuses a missing/wrong one, validates the body, writes one
 * row with only the expected fields, 503 when the table is missing, 404 for an unknown tenant.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const db = vi.hoisted(() => ({
  inserts: [] as Array<Record<string, unknown>>,
  error: null as null | { code?: string; message?: string },
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      expect(table).toBe("page_test_runs");
      return {
        insert(v: Record<string, unknown>) {
          db.inserts.push(v);
          return { select: () => Promise.resolve({ data: db.error ? null : [{ id: "row-1" }], error: db.error }) };
        },
      };
    },
  }),
}));

import { POST } from "./route";

const T = "93b38539-0a9b-4942-bb33-3daa6cff97df";
const BODY = { tenantId: T, page: "/deals", buildSha: "51629ab", results: [{ test: "Add a deal", result: "pass" }, { test: "Back button", result: "fail", note: "filter lost" }] };
const call = (body: unknown, token: string | null = "q-token") =>
  POST(new Request("https://example.invalid/api/agent/page-test-runs", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
const ENV = { ...process.env };

beforeEach(() => {
  db.inserts = []; db.error = null;
  process.env.AGENT_QUEUE_TOKEN = "q-token";
});
afterEach(() => { process.env = { ...ENV }; });

describe("POST /api/agent/page-test-runs", () => {
  it("is closed without a configured token", async () => {
    delete process.env.AGENT_QUEUE_TOKEN;
    expect((await call(BODY)).status).toBe(503);
    expect(db.inserts).toHaveLength(0);
  });

  it("refuses a missing or wrong token without writing", async () => {
    expect((await call(BODY, null)).status).toBe(401);
    expect((await call(BODY, "guess")).status).toBe(401);
    expect((await call(BODY, "q-token-longer")).status).toBe(401);
    expect(db.inserts).toHaveLength(0);
  });

  it("rejects a bad body without writing", async () => {
    expect((await call("not json")).status).toBe(400);
    expect((await call({ ...BODY, tenantId: "x" })).status).toBe(400);
    expect((await call({ ...BODY, page: "https://x.example" })).status).toBe(400);
    expect((await call({ ...BODY, results: [] })).status).toBe(400);
    expect((await call({ ...BODY, results: [{ test: "x", result: "ok" }] })).status).toBe(400);
    expect(db.inserts).toHaveLength(0);
  });

  it("writes one row with only the run fields", async () => {
    const r = await call({ ...BODY, page: "/deals/?tab=kanban" });
    expect(r.status).toBe(200);
    expect(db.inserts).toHaveLength(1);
    const row = db.inserts[0];
    expect(Object.keys(row).sort()).toEqual(["build_sha", "page_path", "results", "run_at", "run_by", "tenant_id"]);
    expect(row.page_path).toBe("/deals");
    expect(row.tenant_id).toBe(T);
    expect(row.results).toEqual([{ test: "Add a deal", result: "pass" }, { test: "Back button", result: "fail", note: "filter lost" }]);
    expect(await r.json()).toMatchObject({ ok: true, id: "row-1", page: "/deals", count: 2 });
  });

  it("says 503 when the table is not set up yet (migration pending)", async () => {
    db.error = { code: "PGRST205", message: "no table" };
    const r = await call(BODY);
    expect(r.status).toBe(503);
    expect((await r.json()).error).toMatch(/migration pending/);
  });

  it("says 404 for an unknown tenant and 500 for other errors", async () => {
    db.error = { code: "23503" };
    expect((await call(BODY)).status).toBe(404);
    db.error = { code: "XX000" };
    expect((await call(BODY)).status).toBe(500);
  });
});
