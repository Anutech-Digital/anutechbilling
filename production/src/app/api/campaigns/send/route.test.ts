/**
 * POST /api/campaigns/send — role gate via withRoute() (R-217, R-051).
 * Pinned: owner/manager may send (200, mails go through the mocked sender only); sales/support/
 * billing get 403 in the withRoute shape ({ ok: false, error }) before any lead is read or mailed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
/* R-897: customer messages switched ON for these tests (the gate has its own tests). */
vi.mock("@/lib/automation/gate.server", () => ({
  automationState: async () => "on",
  cronTenants: async () => ({ on: [], dry: [] }),
  recordRun: async () => {},
  readJobRow: async () => null,
  ensureDefaultOnRow: async () => {},
  readTenantJobs: async () => [],
}));
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  me: { tenant_id: "T1", role: "sales" } as { tenant_id: string; role: string } | null,
  rows: {} as Record<string, unknown>,
  /* R-2011: what a list read (await on the query) returns per table — leads, consent_events. */
  list: {} as Record<string, unknown[]>,
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
  q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: db.list[table] ?? [], error: null }).then(ok);
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
  /* The hand-picked address is lead L-1, who ticked "Send me offers" (R-2011). */
  db.list = {
    leads: [{ id: "L-1", contact_email: "buyer@example.invalid" }],
    consent_events: [{ lead_id: "L-1", choice: "granted", created_at: "2026-11-01T10:00:00Z" }],
  };
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

describe("campaigns send — marketing consent (R-2011, DPDP)", () => {
  beforeEach(() => { db.me = { tenant_id: "T1", role: "owner" }; });

  it("a hand-picked address with no consent record is skipped — nothing mailed, the reply says why", async () => {
    db.list = { leads: [{ id: "L-1", contact_email: "buyer@example.invalid" }], consent_events: [] };
    const res = await call(body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("1 skipped (no consent)");
    expect(mail.send).not.toHaveBeenCalled();
    expect(db.writes.some((w) => w.table === "campaigns")).toBe(false);
  });

  it("an address that is no lead of ours is skipped (unknown consent = no)", async () => {
    db.list = { leads: [], consent_events: [] };
    expect((await call(body)).status).toBe(400);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("the latest choice wins: yes earlier, no later → skipped", async () => {
    db.list = {
      leads: [{ id: "L-1", contact_email: "buyer@example.invalid" }],
      /* Newest first, as the query orders it. */
      consent_events: [
        { lead_id: "L-1", choice: "denied", created_at: "2026-11-02T10:00:00Z" },
        { lead_id: "L-1", choice: "granted", created_at: "2026-11-01T10:00:00Z" },
      ],
    };
    expect((await call(body)).status).toBe(400);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("audience mode: only the lead who said yes is mailed, the other counted as skipped — no consent", async () => {
    db.list = {
      leads: [
        { id: "L-1", contact_name: "Ravi", contact_email: "yes@example.invalid", company: "A", stage: "new", source: "x" },
        { id: "L-2", contact_name: "Old", contact_email: "old@example.invalid", company: "B", stage: "new", source: "x" },
      ],
      consent_events: [{ lead_id: "L-1", choice: "granted", created_at: "2026-11-01T10:00:00Z" }],
    };
    const { recipients: _r, ...audienceBody } = body;
    void _r;
    const res = await call({ ...audienceBody, audience: { stages: ["new"] } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ recipientsCount: 1, skippedNoConsent: 1, sentCount: 1 });
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mail.send.mock.calls[0][0])).toContain("yes@example.invalid");
  });
});
