/**
 * POST /api/seat-requests/[id]/decide — role gate via withRoute() (R-217, R-051).
 * Pinned: owner/manager/billing may decide (200); sales/support/delivery get 403 in the
 * withRoute shape ({ ok: false, error }) with the "who can" message, and nothing is read or written.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  me: { tenant_id: "T1", role: "sales" } as { tenant_id: string; role: string } | null,
  rows: {} as Record<string, unknown>,
  reads: [] as string[],
  actors: [] as string[], // R-051: who createAdminClientFor() was opened for
  writes: [] as Array<{ table: string; op: string; data: unknown }>,
}));

function chain(table: string, user: boolean) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "not", "in", "or", "order", "limit"]) q[m] = () => q;
  q.insert = (data: unknown) => { db.writes.push({ table, op: "insert", data }); return q; };
  q.update = (data: unknown) => { db.writes.push({ table, op: "update", data }); return q; };
  const one = async () => ({ data: table === "users" && user ? db.me : (db.rows[table] ?? null), error: null });
  q.single = one;
  q.maybeSingle = one;
  q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "U1", email: "u1@example.invalid" } } }) },
    from: (t: string) => chain(t, true),
  }),
  createAdminClientFor: (actor: string) => (db.actors.push(actor), {
    from: (t: string) => { db.reads.push(t); return chain(t, false); },
  }),
}));
vi.mock("@/lib/sentry", () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock("@/lib/subscriptions/apply-seat-increase", () => ({ SEAT_INCREASE_SELECT: "*", applySeatIncrease: vi.fn() }));

import { POST } from "./route";

const call = (body: unknown) =>
  POST(
    new NextRequest("https://example.invalid/api/seat-requests/SR1/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "SR1" }) },
  );

beforeEach(() => {
  db.me = { tenant_id: "T1", role: "sales" };
  db.rows = { seat_requests: { id: "SR1", tenant_id: "T1", status: "pending", subscription_id: "S1" } };
  db.reads = [];
  db.actors = [];
  db.writes = [];
});

describe("seat-requests decide — role gate (R-217)", () => {
  it.each(["sales", "support", "delivery", "accountant"])("%s → 403, withRoute shape, nothing read or written", async (role) => {
    db.me = { tenant_id: "T1", role };
    const res = await call({ decision: "rejected", note: "no" });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBe("Only Owner, Manager, Billing can change seats or subscription terms. Ask one of them to do it.");
    expect(db.reads).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  it.each(["owner", "manager", "billing"])("%s → 200 and the rejection is saved", async (role) => {
    db.me = { tenant_id: "T1", role };
    const res = await call({ decision: "rejected", note: "not now" });
    expect(res.status).toBe(200);
    expect(db.actors).toEqual(["U1"]); // R-051: audit log gets the signed-in caller
    expect((await res.json()).status).toBe("rejected");
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]).toMatchObject({ table: "seat_requests", op: "update", data: { status: "rejected", decided_by: "U1", decision_note: "not now" } });
  });

  it("another tenant's request stays 403 for an allowed role", async () => {
    db.me = { tenant_id: "T2", role: "owner" };
    const res = await call({ decision: "rejected" });
    expect(res.status).toBe(403);
    expect(db.writes).toEqual([]);
  });

  it("a bad decision is 400 with the old message", async () => {
    db.me = { tenant_id: "T1", role: "owner" };
    const res = await call({ decision: "maybe" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("decision must be 'approved' or 'rejected'");
  });
});
