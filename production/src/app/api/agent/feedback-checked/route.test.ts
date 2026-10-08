/**
 * /api/agent/feedback-checked (R-188): the AI browser check ticks a fixed report.
 * Pinned: closed without a token, refuses a wrong one, rejects a bad id, touches only a fixed
 * and unchecked row, writes only checked_at / checked_by_name, and says 404 when nothing matched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const db = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
  eqs: [] as Array<[string, unknown]>,
  iss: [] as Array<[string, unknown]>,
  matched: true,
  error: null as null | { message: string },
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      expect(table).toBe("feedback");
      const q = {
        update(v: Record<string, unknown>) { db.updates.push(v); return q; },
        eq(c: string, v: unknown) { db.eqs.push([c, v]); return q; },
        is(c: string, v: unknown) { db.iss.push([c, v]); return q; },
        select() {
          return Promise.resolve({ data: db.error ? null : db.matched ? [{ id: "x" }] : [], error: db.error });
        },
      };
      return q;
    },
  }),
}));

import { POST } from "./route";
import { AI_CHECKER_NAME } from "./checker-name";

const ID = "93b38539-0a9b-4942-bb33-3daa6cff97df";
const call = (body: unknown, token: string | null = "q-token") =>
  POST(new Request("https://example.invalid/api/agent/feedback-checked", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }));
const ENV = { ...process.env };

beforeEach(() => {
  db.updates = []; db.eqs = []; db.iss = []; db.matched = true; db.error = null;
  process.env.AGENT_QUEUE_TOKEN = "q-token";
});
afterEach(() => { process.env = { ...ENV }; });

describe("POST /api/agent/feedback-checked", () => {
  it("is closed without a configured token", async () => {
    delete process.env.AGENT_QUEUE_TOKEN;
    expect((await call({ id: ID })).status).toBe(503);
    expect(db.updates).toHaveLength(0);
  });

  it("refuses a missing or wrong token without writing", async () => {
    expect((await call({ id: ID }, null)).status).toBe(401);
    expect((await call({ id: ID }, "guess")).status).toBe(401);
    expect(db.updates).toHaveLength(0);
  });

  it("rejects a body without a proper id", async () => {
    expect((await call({ id: "1; drop table" })).status).toBe(400);
    expect((await call({})).status).toBe(400);
    expect(db.updates).toHaveLength(0);
  });

  it("ticks only a fixed, unchecked report and writes only the check fields", async () => {
    const r = await call({ id: ID });
    expect(r.status).toBe(200);
    expect(db.eqs).toEqual([["id", ID], ["status", "fixed"]]);
    expect(db.iss).toEqual([["checked_at", null]]);
    expect(Object.keys(db.updates[0]).sort()).toEqual(["checked_at", "checked_by_name", "updated_at"]);
    expect(db.updates[0].checked_by_name).toBe(AI_CHECKER_NAME);
  });

  it("says 404 when no fixed unchecked report matched", async () => {
    db.matched = false;
    expect((await call({ id: ID })).status).toBe(404);
  });
});
