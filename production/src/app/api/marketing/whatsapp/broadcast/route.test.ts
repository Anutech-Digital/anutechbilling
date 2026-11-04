/**
 * POST /api/marketing/whatsapp/broadcast — R-2011 (DPDP): a broadcast goes ONLY to leads whose
 * latest marketing consent (consent_events, purpose marketing) is 'granted'. A lead with no
 * record — every lead from before R-2011 — is skipped and counted as "skipped — no consent".
 * Before R-2011 every lead with a phone that had not sent STOP got it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  me: { tenant_id: "T1", role: "owner" } as { tenant_id: string; role: string } | null,
  rows: {} as Record<string, unknown>,
  list: {} as Record<string, unknown[]>,
  writes: [] as Array<{ table: string; op: string; data: unknown }>,
}));
const wa = vi.hoisted(() => ({ send: vi.fn(), creds: vi.fn() }));

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
  createAdminClient: () => ({ from: (t: string) => chain(t, false) }),
  createAdminClientFor: () => ({ from: (t: string) => chain(t, false) }),
}));
vi.mock("@/lib/sentry", () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock("@/lib/whatsapp/client", () => ({ resolveWhatsAppCreds: wa.creds }));
vi.mock("@/lib/messaging", () => ({ sendCustomerWhatsApp: wa.send }));

import { POST } from "./route";

const TPL = "11111111-1111-4111-8111-111111111111";
const call = (b: unknown) =>
  POST(new NextRequest("https://example.invalid/api/marketing/whatsapp/broadcast", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b),
  }));

beforeEach(() => {
  db.me = { tenant_id: "T1", role: "owner" };
  db.rows = {
    whatsapp_templates: { id: TPL, name: "offer", language: "en", body: "Hi {{1}}", param_map: ["first_name"], status: "approved" },
    tenants: { name: "Anutech" },
    whatsapp_broadcasts: { id: "BC-1" },
  };
  db.list = {
    leads: [
      { id: "L-YES", contact_name: "Ravi Kumar", company: "A", contact_phone: "9810000001" },
      { id: "L-OLD", contact_name: "Old Lead", company: "B", contact_phone: "9810000002" },
      { id: "L-NO", contact_name: "Said No", company: "C", contact_phone: "9810000003" },
    ],
    whatsapp_opt_outs: [],
    /* Newest first, as the query orders it. L-OLD has no row (a lead from before R-2011). */
    consent_events: [
      { lead_id: "L-NO", choice: "denied", created_at: "2026-11-02T10:00:00Z" },
      { lead_id: "L-YES", choice: "granted", created_at: "2026-11-01T10:00:00Z" },
      { lead_id: "L-NO", choice: "granted", created_at: "2026-11-01T09:00:00Z" },
    ],
  };
  db.writes = [];
  wa.send.mockReset();
  wa.send.mockResolvedValue({ status: "sent" });
  wa.creds.mockReset();
  wa.creds.mockResolvedValue({ token: "test-only" });
});

describe("WhatsApp broadcast — marketing consent only (R-2011)", () => {
  it("preview counts only the lead who said yes; the others show as skipped — no consent", async () => {
    const res = await call({ templateId: TPL, audience: { stages: ["new"] }, dryRun: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ recipients: 1, skippedNoConsent: 2, skippedOptOut: 0 });
    expect(wa.send).not.toHaveBeenCalled();
  });

  it("send goes to the consented lead only", async () => {
    const res = await call({ templateId: TPL, audience: { stages: ["new"] } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ recipients: 1, sent: 1, skippedNoConsent: 2 });
    expect(wa.send).toHaveBeenCalledTimes(1);
    expect(wa.send.mock.calls[0][0]).toMatchObject({ related: { leadId: "L-YES" } });
  });

  it("nobody consented → nothing sent, the error says why", async () => {
    db.list.consent_events = [];
    const res = await call({ templateId: TPL, audience: { stages: ["new"] } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("3 skipped (no consent)");
    expect(wa.send).not.toHaveBeenCalled();
    expect(db.writes.some((w) => w.table === "whatsapp_broadcasts")).toBe(false);
  });
});
