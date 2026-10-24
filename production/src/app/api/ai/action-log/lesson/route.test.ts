/**
 * R-727: POST /api/ai/action-log/lesson — an owner or manager approves (Use lesson) or discards a
 * website-chat lesson the AI proposed. Approval writes a decision row; the chat reads only those.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const me = vi.hoisted(() => ({ user: { id: "u-1" } as { id: string } | null, tenant: "t-1" as string | null, role: "owner" }));
const db = vi.hoisted(() => ({
  proposal: null as null | Record<string, unknown>,
  decisions: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<Record<string, unknown>>,
  insertError: null as null | { message: string },
  reads: [] as Array<{ table: string; calls: Array<[string, unknown[]]> }>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: me.user } }) },
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        single: async () => ({ data: me.tenant ? { tenant_id: me.tenant, role: me.role } : null }),
      };
      return q;
    },
  }),
}));

vi.mock("@/lib/supabase/bare", () => ({
  createBareClient: () => ({
    from: (table: string) => {
      const read = { table, calls: [] as Array<[string, unknown[]]> };
      db.reads.push(read);
      const q: Record<string, unknown> = {};
      for (const k of ["select", "eq", "in", "limit", "order"]) {
        q[k] = (...a: unknown[]) => { read.calls.push([k, a]); return q; };
      }
      q.maybeSingle = async () => ({ data: db.proposal, error: null });
      q.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: db.decisions, error: null }).then(res);
      q.insert = async (row: Record<string, unknown>) => { db.inserts.push(row); return { error: db.insertError }; };
      return q;
    },
  }),
}));

import { POST } from "./route";

const LESSON = "Ask for the seat count before naming an edition.";
const call = (body: unknown) =>
  POST(new Request("https://app.example.invalid/api/ai/action-log/lesson", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never);

beforeEach(() => {
  me.user = { id: "u-1" }; me.tenant = "t-1"; me.role = "owner";
  db.proposal = { id: 41, tenant_id: "t-1", action: "public_chat.learn", outcome: "held", reason: LESSON };
  db.decisions = []; db.inserts = []; db.insertError = null; db.reads = [];
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://db.example.invalid");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-not-a-key");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("POST /api/ai/action-log/lesson", () => {
  it("signed out → 401, nothing written", async () => {
    me.user = null;
    expect((await call({ id: 41, decision: "approve" })).status).toBe(401);
    expect(db.inserts).toHaveLength(0);
  });

  it("a sales user → 403 that says who can do it", async () => {
    me.role = "sales";
    const r = await call({ id: 41, decision: "approve" });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/owner or a manager/i);
    expect(db.inserts).toHaveLength(0);
  });

  it("bad body → 400", async () => {
    expect((await call({ id: "x", decision: "approve" })).status).toBe(400);
    expect((await call({ id: 41, decision: "maybe" })).status).toBe(400);
  });

  it("approve → a decision row the chat will read: did, public_chat_lesson, approvedFrom", async () => {
    const r = await call({ id: 41, decision: "approve" });
    expect(r.status).toBe(200);
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]).toMatchObject({
      tenant_id: "t-1", action: "public_chat.learn", outcome: "did", reason: LESSON,
      mode: "hold", entity: "public_chat_lesson", entity_id: "41",
      facts: { approvedFrom: 41, decidedBy: "u-1" },
    });
    /* The proposal is looked up in the caller's OWN workspace only. */
    const proposalRead = db.reads[0];
    expect(proposalRead.calls).toEqual(expect.arrayContaining([["eq", ["tenant_id", "t-1"]], ["eq", ["outcome", "held"]]]));
  });

  it("discard → skipped, never readable by the chat", async () => {
    expect((await call({ id: 41, decision: "discard" })).status).toBe(200);
    expect(db.inserts[0]).toMatchObject({ outcome: "skipped", entity: "public_chat_lesson", entity_id: "41", facts: { rejectedFrom: 41 } });
  });

  it("another workspace's or an unknown proposal → 404 with what to do", async () => {
    db.proposal = null;
    const r = await call({ id: 41, decision: "approve" });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toMatch(/reload/i);
    expect(db.inserts).toHaveLength(0);
  });

  it("already decided → 409, not a second row", async () => {
    db.decisions = [{ id: 50, outcome: "did" }];
    const r = await call({ id: 41, decision: "discard" });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/already/i);
    expect(db.inserts).toHaveLength(0);
  });

  it("a lesson that fails the guard (digits/links) cannot be approved — only discarded", async () => {
    db.proposal = { ...db.proposal!, reason: "Pay 5000 on https://evil.example now please" };
    const r = await call({ id: 41, decision: "approve" });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toMatch(/Discard/);
    expect(db.inserts).toHaveLength(0);
  });

  it("a failed write is said, not reported as done", async () => {
    db.insertError = { message: "boom" };
    const r = await call({ id: 41, decision: "approve" });
    expect(r.status).toBe(500);
    expect((await r.json()).error).toMatch(/try again/i);
  });
});
