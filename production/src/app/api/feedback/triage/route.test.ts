/**
 * /api/feedback/triage — R-357 auto-send: a fresh report goes to the AI queue on its own when the
 * workspace switch is ON (default), and stays in Open when it is OFF, a re-triage, or junk.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const db = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
  tenant: null as null | Record<string, unknown>,
  updates: [] as Array<Record<string, unknown>>,
  updateFilters: [] as Array<Array<[string, string, unknown]>>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: (table: string) => {
      let mode: "read" | "update" = "read";
      let filters: Array<[string, string, unknown]> = [];
      const q = {
        select() {
          if (mode === "update") {
            db.updateFilters.push(filters);
            return Promise.resolve({ data: [{ id: "x" }], error: null });
          }
          return q;
        },
        update(v: Record<string, unknown>) { mode = "update"; filters = []; db.updates.push(v); return q; },
        eq(c: string, v: unknown) { filters.push(["eq", c, v]); return q; },
        is(c: string, v: unknown) { filters.push(["is", c, v]); return q; },
        maybeSingle() {
          return Promise.resolve({ data: table === "tenants" ? db.tenant : db.row, error: null });
        },
        then(resolve: (v: { data: null; error: null; count: number }) => unknown) {
          /* screenshot count (head select) and the triage write both await the builder */
          return Promise.resolve({ data: null, error: null, count: 0 }).then(resolve);
        },
      };
      return q;
    },
  }),
}));

vi.mock("@/lib/ai/gemini", () => ({
  resolveGeminiConfig: async () => ({ apiKey: null, model: null }),
  geminiJson: async () => null,
}));

import { POST } from "./route";
import type { NextRequest } from "next/server";

const ID = "93b38539-0a9b-4942-bb33-3daa6cff97df";
const call = () =>
  POST(new Request("https://example.invalid/api/feedback/triage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ feedbackId: ID }),
  }) as unknown as NextRequest);

const queued = () => db.updates.filter((u) => u.status === "agent_queued");

beforeEach(() => {
  db.updates = []; db.updateFilters = [];
  db.tenant = { id: "t1" }; // no feedback_auto_send column yet → ON
  db.row = {
    id: ID, tenant_id: "t1", reported_type: "bug", reported_severity: "high",
    title: "Invoice PDF not opening", body: "Invoice PDF not opening, spinner forever on /invoices",
    page_path: "/invoices", reporter_name: "A", reporter_email: null, created_at: "2026-10-07T05:00:00Z",
    status: "open", dispatched_at: null, triaged_at: null,
  };
});

describe("POST /api/feedback/triage — R-357 auto-send", () => {
  it("switch ON (default, column missing): a fresh report is queued for the AI", async () => {
    const r = await call();
    expect(r.status).toBe(200);
    expect((await r.json()).autoSent).toBe(true);
    expect(queued()).toHaveLength(1);
    expect(queued()[0].dispatched_at).toEqual(expect.any(String));
    expect(queued()[0].dispatched_by).toBeNull();
    const f = db.updateFilters[db.updateFilters.length - 1];
    expect(f).toEqual([["eq", "id", ID], ["eq", "status", "open"], ["is", "dispatched_at", null]]);
  });

  it("switch OFF: the report is triaged but stays in Open", async () => {
    db.tenant = { id: "t1", feedback_auto_send: false };
    const r = await call();
    expect((await r.json()).autoSent).toBe(false);
    expect(queued()).toHaveLength(0);
    expect(db.updates.some((u) => u.triage_status === "triaged")).toBe(true);
  });

  it("a re-triage, an already-dispatched or a junk report is not auto-sent", async () => {
    db.row = { ...db.row!, triaged_at: "2026-10-06T00:00:00Z" };
    await call();
    db.row = { ...db.row!, triaged_at: null, dispatched_at: "2026-10-06T00:00:00Z" };
    await call();
    db.row = { ...db.row!, dispatched_at: null, title: "test", body: "test" };
    await call();
    expect(queued()).toHaveLength(0);
  });
});
