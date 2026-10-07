/**
 * /api/agent/feedback-fixed (R-200): the AI marks a report it fixed.
 * Pinned: closed without a token, refuses a wrong one, needs a uuid and a note, touches only
 * open / queued / unchecked rows, writes only the status + note + check fields, 404 on no match.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const db = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
  eqs: [] as Array<[string, unknown]>,
  ins: [] as Array<[string, unknown]>,
  iss: [] as Array<[string, unknown]>,
  matched: true,
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      expect(table).toBe("feedback");
      const q = {
        update(v: Record<string, unknown>) { db.updates.push(v); return q; },
        eq(c: string, v: unknown) { db.eqs.push([c, v]); return q; },
        in(c: string, v: unknown) { db.ins.push([c, v]); return q; },
        is(c: string, v: unknown) { db.iss.push([c, v]); return q; },
        select() { return Promise.resolve({ data: db.matched ? [{ id: "x" }] : [], error: null }); },
      };
      return q;
    },
  }),
}));

import { POST } from "./route";

const ID = "22a67769-5549-473b-960d-c2a04c42c2a7";
const call = (body: unknown, token: string | null = "q-token") =>
  POST(new Request("https://example.invalid/api/agent/feedback-fixed", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }));
const ENV = { ...process.env };

beforeEach(() => {
  db.updates = []; db.eqs = []; db.ins = []; db.iss = []; db.matched = true;
  process.env.AGENT_QUEUE_TOKEN = "q-token";
});
afterEach(() => { process.env = { ...ENV }; });

describe("POST /api/agent/feedback-fixed", () => {
  it("is closed without a token and refuses a wrong one", async () => {
    delete process.env.AGENT_QUEUE_TOKEN;
    expect((await call({ id: ID, note: "R-199 fixed" })).status).toBe(503);
    process.env.AGENT_QUEUE_TOKEN = "q-token";
    expect((await call({ id: ID, note: "R-199 fixed" }, "nope")).status).toBe(401);
    expect(db.updates).toHaveLength(0);
  });

  it("needs a real id and a note", async () => {
    expect((await call({ id: "x", note: "R-199 fixed" })).status).toBe(400);
    expect((await call({ id: ID })).status).toBe(400);
    expect((await call({ id: ID, note: "ok" })).status).toBe(400);
    expect(db.updates).toHaveLength(0);
  });

  it("marks an open/queued/unchecked report fixed with the note, and nothing else", async () => {
    const r = await call({ id: ID, note: "AI ne theek kiya: R-199 (d17e5921) — staging par 5 PM ke baad" });
    expect(r.status).toBe(200);
    expect(db.eqs).toEqual([["id", ID]]);
    expect(db.ins).toEqual([["status", ["open", "agent_queued", "fixed"]]]);
    expect(db.iss).toEqual([["checked_at", null]]);
    expect(Object.keys(db.updates[0]).sort()).toEqual(["checked_at", "checked_by_name", "resolution_note", "resolved_at", "status", "updated_at"]);
    expect(db.updates[0].status).toBe("fixed");
  });

  it("caps the note and collapses whitespace", async () => {
    await call({ id: ID, note: "a  b\n" + "c".repeat(600) });
    expect(String(db.updates[0].resolution_note)).toHaveLength(500);
    expect(String(db.updates[0].resolution_note).startsWith("a b c")).toBe(true);
  });

  it("404 when nothing matched (won't fix, or already checked)", async () => {
    db.matched = false;
    expect((await call({ id: ID, note: "R-199 fixed" })).status).toBe(404);
  });
});
