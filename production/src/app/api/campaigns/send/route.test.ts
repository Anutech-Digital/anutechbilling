/**
 * POST /api/campaigns/send — role gate via withRoute() (R-217, R-051).
 * Pinned: owner/manager may send (200, mails go through the mocked sender only); sales/support/
 * billing get 403 in the withRoute shape ({ ok: false, error }) before any lead is read or mailed.
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
const mail = vi.hoisted(() => ({ send: vi.fn() }));

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
    rpc: async () => ({ data: "CMP-0001", error: null }),
  }),
}));
vi.mock("@/lib/sentry", () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock("@/lib/email/send", () => ({ sendEmail: mail.send, isEmailConfigured: () => false }));

import { POST } from "./route";

const body = {
  name: "Diwali offer",
  subject: "Hello {{name}}",
  body: "Hi {{name}}, a note from us.",
  recipients: [{ email: "buyer@example.invalid", name: "Ravi Kumar", company: "Acme" }],
};
const call = (b: unknown) =>
  POST(new NextRequest("https://example.invalid/api/campaigns/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(b),
  }));

beforeEach(() => {
  /* Unsubscribe links are signed; a throwaway value for the test only. */
  vi.stubEnv("UNSUBSCRIBE_SIGNING_SECRET", "test-only-unsubscribe-secret");
  db.me = { tenant_id: "T1", role: "sales" };
  db.rows = { tenants: { name: "Anutech", email: "hi@example.invalid", phone: null } };
  db.reads = [];
  db.actors = [];
  db.writes = [];
  mail.send.mockReset();
  mail.send.mockResolvedValue({ status: "stubbed", providerId: "stub-1" });
});

describe("campaigns send — role gate (R-217)", () => {
  it.each(["sales", "sales_senior", "support", "billing", "delivery"])("%s → 403, withRoute shape, nothing read or mailed", async (role) => {
    db.me = { tenant_id: "T1", role };
    const res = await call(body);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBe("Only Owner, Manager can send a campaign. Ask one of them to do it.");
    expect(db.reads).toEqual([]);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it.each(["owner", "manager"])("%s → 200, one (mocked) mail, campaign saved", async (role) => {
    db.me = { tenant_id: "T1", role };
    const res = await call(body);
    expect(res.status).toBe(200);
    expect(db.actors).toEqual(["U1"]); // R-051: audit log gets the signed-in caller
    expect(await res.json()).toMatchObject({ ok: true, campaignId: "CMP-0001", recipientsCount: 1, sentCount: 1, failedCount: 0, mode: "stub" });
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(db.writes.find((w) => w.table === "campaigns" && w.op === "insert")?.data).toMatchObject({ tenant_id: "T1", created_by: "U1" });
  });

  it("a bad body is 400 for an allowed role", async () => {
    db.me = { tenant_id: "T1", role: "owner" };
    expect((await call({ name: "x" })).status).toBe(400);
    expect(mail.send).not.toHaveBeenCalled();
  });
});
