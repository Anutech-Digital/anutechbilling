/**
 * /api/agent/feedback-queue: the AI worker's read-only list of "Queued for agent" reports.
 * Pinned: fails closed without a token, refuses a wrong one, reads only agent_queued rows,
 * and never asks for the reporter's name or email.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const db = vi.hoisted(() => ({
  select: "" as string,
  filters: [] as Array<[string, unknown]>,
  writes: 0,
  rows: [] as Array<Record<string, unknown>>,
  error: null as null | { message: string },
  /** R-357: the first read fails on an unknown column (claim migration not applied yet). */
  missingColumnOnce: false,
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      expect(table).toBe("feedback");
      const q = {
        select(cols: string) { db.select = cols; return q; },
        eq(col: string, v: unknown) { db.filters.push([col, v]); return q; },
        order() { return q; },
        limit() {
          if (db.missingColumnOnce) {
            db.missingColumnOnce = false;
            return Promise.resolve({ data: null, error: { code: "42703", message: "column feedback.agent_claimed_at does not exist" } });
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
  db.select = ""; db.filters = []; db.writes = 0; db.error = null; db.missingColumnOnce = false;
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
    expect(body.items).toEqual(db.rows);
    expect(db.filters).toEqual([["status", "agent_queued"]]);
    expect(db.select).toContain("directive");
    expect(db.select).toContain("problem_summary");
  });

  it("never asks for the reporter's identity and never writes", async () => {
    await call("q-token");
    expect(db.select).not.toMatch(/reporter_|reported_by|body|ai_chat_summary/);
    expect(db.writes).toBe(0);
  });

  it("R-357: does not hand out a report an AI card already claimed", async () => {
    db.rows = [
      { id: "f1", title: "A", agent_claimed_at: null },
      { id: "f2", title: "B", agent_claimed_at: "2026-10-07T06:00:00Z" },
    ];
    const body = await (await call("q-token")).json();
    expect(body.items).toEqual([{ id: "f1", title: "A" }]);
    expect(db.select).toContain("agent_claimed_at");
  });

  it("R-357: before the claim migration it falls back to the plain read", async () => {
    db.missingColumnOnce = true;
    const r = await call("q-token");
    expect(r.status).toBe(200);
    expect((await r.json()).items).toEqual(db.rows);
    expect(db.select).not.toContain("agent_claimed_at");
  });

  it("says so on a read error instead of returning an empty queue", async () => {
    db.error = { message: "boom" };
    const r = await call("q-token");
    expect(r.status).toBe(500);
  });
});
