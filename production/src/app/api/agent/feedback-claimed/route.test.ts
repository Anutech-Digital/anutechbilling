/**
 * /api/agent/feedback-claimed (R-357): the AI worker records which board card took a report.
 * Pinned: closed without a token, refuses a wrong one, rejects a bad id or card, writes only the
 * claim fields on an open/queued unclaimed row, is idempotent for the same card, 409 for another,
 * and names the migration when the columns are not there yet.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const db = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
  eqs: [] as Array<[string, unknown]>,
  ins: [] as Array<[string, unknown]>,
  iss: [] as Array<[string, unknown]>,
  matched: true,
  existing: null as null | Record<string, unknown>,
  error: null as null | { code?: string; message: string },
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      expect(table).toBe("feedback");
      let mode: "update" | "read" = "read";
      const q = {
        update(v: Record<string, unknown>) { mode = "update"; db.updates.push(v); return q; },
        eq(c: string, v: unknown) { if (mode === "update") db.eqs.push([c, v]); return q; },
        in(c: string, v: unknown) { db.ins.push([c, v]); return q; },
        is(c: string, v: unknown) { db.iss.push([c, v]); return q; },
        select() {
          if (mode === "update") {
            return Promise.resolve({ data: db.error ? null : db.matched ? [{ id: "x" }] : [], error: db.error });
          }
          return q;
        },
        maybeSingle() { return Promise.resolve({ data: db.existing, error: null }); },
      };
      return q;
    },
  }),
}));

import { POST } from "./route";

const ID = "93b38539-0a9b-4942-bb33-3daa6cff97df";
const call = (body: unknown, token: string | null = "q-token") =>
  POST(new Request("https://example.invalid/api/agent/feedback-claimed", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }));
const ENV = { ...process.env };

beforeEach(() => {
  db.updates = []; db.eqs = []; db.ins = []; db.iss = [];
  db.matched = true; db.existing = null; db.error = null;
  process.env.AGENT_QUEUE_TOKEN = "q-token";
});
afterEach(() => { process.env = { ...ENV }; });

describe("POST /api/agent/feedback-claimed", () => {
  it("is closed without a configured token", async () => {
    delete process.env.AGENT_QUEUE_TOKEN;
    expect((await call({ id: ID, card: "R-357" })).status).toBe(503);
    expect(db.updates).toHaveLength(0);
  });

  it("refuses a missing or wrong token without writing", async () => {
    expect((await call({ id: ID, card: "R-357" }, null)).status).toBe(401);
    expect((await call({ id: ID, card: "R-357" }, "guess")).status).toBe(401);
    expect(db.updates).toHaveLength(0);
  });

  it("rejects a bad id or card", async () => {
    expect((await call({ id: "1; drop", card: "R-357" })).status).toBe(400);
    expect((await call({ id: ID, card: "R-357'; --" })).status).toBe(400);
    expect((await call({ id: ID })).status).toBe(400);
    expect(db.updates).toHaveLength(0);
  });

  it("claims only an open/queued unclaimed report and writes only the claim fields", async () => {
    const r = await call({ id: ID, card: "R-357" });
    expect(r.status).toBe(200);
    expect(db.eqs).toEqual([["id", ID]]);
    expect(db.ins).toEqual([["status", ["open", "agent_queued"]]]);
    expect(db.iss).toEqual([["agent_claimed_at", null]]);
    expect(Object.keys(db.updates[0]).sort()).toEqual(["agent_card", "agent_claimed_at", "updated_at"]);
    expect(db.updates[0].agent_card).toBe("R-357");
  });

  it("same card again is a no-op success; another card is 409; nothing is 404", async () => {
    db.matched = false;
    db.existing = { id: ID, agent_card: "R-357", agent_claimed_at: "2026-10-07T06:00:00Z" };
    const same = await call({ id: ID, card: "R-357" });
    expect(same.status).toBe(200);
    expect((await same.json()).already).toBe(true);
    expect((await call({ id: ID, card: "R-358" })).status).toBe(409);
    db.existing = { id: ID, status: "fixed" };
    expect((await call({ id: ID, card: "R-357" })).status).toBe(404);
  });

  it("names the migration when the columns do not exist yet", async () => {
    db.error = { code: "PGRST204", message: "Could not find the 'agent_card' column" };
    const r = await call({ id: ID, card: "R-357" });
    expect(r.status).toBe(503);
    expect((await r.json()).error).toMatch(/20261007110000_feedback_agent_claim/);
  });
});
