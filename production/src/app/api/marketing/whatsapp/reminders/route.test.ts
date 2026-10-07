/**
 * /api/marketing/whatsapp/reminders — the S28 settings routes.
 *
 * What must hold: only owner / manager can read or change it; every query is pinned to the
 * CALLER's tenant (never one from the body); a mapping whose {{n}} count does not match the
 * app's copy of the template is refused before it reaches the table; and GET reports the
 * automation dial and the approval the cron will actually check.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

type Call = { table: string; op: string; args: unknown[] };

const state = vi.hoisted(() => ({
  role: "owner" as string,
  calls: [] as Call[],
  data: {} as Record<string, unknown>,
  policy: { killSwitch: false, modes: {} as Record<string, string> },
  creds: { accessToken: "t", phoneNumberId: "p" } as unknown,
}));

vi.mock("@/lib/supabase/server", () => {
  /** A chainable fake: records every call, resolves to state.data[table]. */
  function builder(table: string) {
    const rec = (op: string) => (...args: unknown[]) => { state.calls.push({ table, op, args }); return b; };
    const result = () => {
      const d = state.data[table];
      return { data: d === undefined ? null : d, error: null };
    };
    const b: Record<string, unknown> = {
      select: rec("select"), eq: rec("eq"), order: rec("order"), limit: rec("limit"),
      upsert: rec("upsert"), delete: rec("delete"), in: rec("in"),
      maybeSingle: async () => { state.calls.push({ table, op: "maybeSingle", args: [] }); const r = result(); return { ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data }; },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad),
    };
    return b;
  }
  return {
    createClient: () => ({
      auth: { getUser: async () => ({ data: { user: { id: "U1", email: "o@example.invalid" } } }) },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { tenant_id: "T1", role: state.role }, error: null }) }) }) }),
    }),
    createAdminClient: () => ({ from: (t: string) => builder(t) }),
  };
});
vi.mock("@/lib/whatsapp/client", () => ({ resolveWhatsAppCreds: async () => state.creds }));
vi.mock("@/lib/ai/autonomy.server", () => ({ loadAutonomyPolicy: async () => state.policy }));
vi.mock("@/lib/sentry", () => ({ Sentry: { captureException: vi.fn() } }));

import { GET, PATCH, PUT, DELETE } from "./route";

const req = (method: string, body?: unknown) =>
  new Request("https://x.invalid/api/marketing/whatsapp/reminders", {
    method, body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as NextRequest;

const eqs = (table: string) => state.calls.filter((c) => c.table === table && c.op === "eq").map((c) => c.args);
const op = (table: string, o: string) => state.calls.find((c) => c.table === table && c.op === o);

beforeEach(() => {
  state.role = "owner";
  state.calls = [];
  state.data = {};
  state.policy = { killSwitch: false, modes: {} };
  state.creds = { accessToken: "t", phoneNumberId: "p" };
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("role gate — the switch messages customers", () => {
  it.each(["sales", "billing", "support", "accountant"])("%s gets 403 on every method, nothing written", async (role) => {
    state.role = role;
    for (const [fn, m, body] of [[GET, "GET"], [PATCH, "PATCH", { enabled: true }], [PUT, "PUT", { kind: "invoice_due", template_name: "x", param_map: [] }], [DELETE, "DELETE", { kind: "invoice_due" }]] as const) {
      const res = await fn(req(m, body));
      expect(res.status, m).toBe(403);
      expect((await res.json()).error).toMatch(/owner \/ manager/);
    }
    expect(state.calls).toEqual([]);
  });

  it("manager is allowed", async () => {
    state.role = "manager";
    expect((await PATCH(req("PATCH", { enabled: false }))).status).toBe(200);
  });
});

describe("PATCH — the master switch", () => {
  it("upserts for the caller's tenant, ignoring any tenant_id in the body", async () => {
    const res = await PATCH(req("PATCH", { enabled: true, tenant_id: "OTHER" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enabled: true });
    const up = op("whatsapp_reminder_settings", "upsert")!;
    expect(up.args[0]).toMatchObject({ tenant_id: "T1", enabled: true, updated_by: "U1" });
    expect(up.args[1]).toEqual({ onConflict: "tenant_id" });
  });

  it("refuses a non-boolean", async () => {
    expect((await PATCH(req("PATCH", { enabled: "yes" }))).status).toBe(400);
    expect(state.calls).toEqual([]);
  });
});

describe("PUT — template per kind", () => {
  const good = { kind: "invoice_due", template_name: "invoice_due_v1", language: "en",
    param_map: ["customer_name", "invoice_id", "amount", "due_date", "seller_name"], enabled: true };

  it("saves when the {{n}} count matches the app's copy of the template", async () => {
    state.data.whatsapp_templates = { body: "Hi {{1}}, {{2}} {{3}} {{4}} — {{5}}" };
    const res = await PUT(req("PUT", { ...good, tenant_id: "OTHER" }));
    expect(res.status).toBe(200);
    expect(eqs("whatsapp_templates")).toEqual([["tenant_id", "T1"], ["name", "invoice_due_v1"], ["language", "en"]]);
    const up = op("whatsapp_reminder_templates", "upsert")!;
    expect(up.args[0]).toMatchObject({ tenant_id: "T1", kind: "invoice_due", template_name: "invoice_due_v1", param_map: good.param_map });
    expect(up.args[1]).toEqual({ onConflict: "tenant_id,kind" });
  });

  it("refuses a count mismatch with the numbers, and writes nothing", async () => {
    state.data.whatsapp_templates = { body: "Hi {{1}} {{2}}" };
    const res = await PUT(req("PUT", good));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/2 slots.*5 fields/);
    expect(op("whatsapp_reminder_templates", "upsert")).toBeUndefined();
  });

  it("allows a name the app has not synced yet (no body to count against)", async () => {
    const res = await PUT(req("PUT", { ...good, template_name: "not_synced_yet" }));
    expect(res.status).toBe(200);
  });

  it("lower-cases the name, refuses an unknown kind and an unknown field", async () => {
    await PUT(req("PUT", { ...good, template_name: "Invoice_Due_V1" }));
    expect((op("whatsapp_reminder_templates", "upsert")!.args[0] as { template_name: string }).template_name).toBe("invoice_due_v1");
    expect((await PUT(req("PUT", { ...good, kind: "birthday" }))).status).toBe(400);
    expect((await PUT(req("PUT", { ...good, param_map: ["first_name"] }))).status).toBe(400);
    expect((await PUT(req("PUT", { ...good, template_name: "has space" }))).status).toBe(400);
  });
});

describe("DELETE — remove one kind's mapping", () => {
  it("deletes only that kind, only in the caller's tenant", async () => {
    const res = await DELETE(req("DELETE", { kind: "renewal_grace" }));
    expect(res.status).toBe(200);
    expect(op("whatsapp_reminder_templates", "delete")).toBeDefined();
    expect(eqs("whatsapp_reminder_templates")).toEqual([["tenant_id", "T1"], ["kind", "renewal_grace"]]);
  });
});

describe("GET — the screen's view", () => {
  it("reports switch, dial, connection, per-kind readiness and the last 20 log rows, all tenant-pinned", async () => {
    state.data = {
      whatsapp_reminder_settings: { enabled: true, updated_at: "2026-09-29T10:00:00Z" },
      whatsapp_reminder_templates: [
        { kind: "invoice_due", template_name: "invoice_due_v1", language: "en", param_map: ["customer_name"], enabled: true, updated_at: "x" },
        { kind: "renewal_final", template_name: "renewal_today_v1", language: "en", param_map: [], enabled: true, updated_at: "x" },
      ],
      whatsapp_templates: [
        { name: "invoice_due_v1", language: "en", status: "approved", body: "Hi {{1}}" },
        { name: "renewal_today_v1", language: "en", status: "submitted", body: "Hi" },
      ],
      whatsapp_reminder_log: [{ id: "L1", kind: "invoice_due", status: "read" }],
    };
    state.policy = { killSwitch: false, modes: { "renewal.send": "hold" } };

    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.enabled).toBe(true);
    expect(j.connected).toBe(true);
    expect(j.dial).toEqual({ killSwitch: false, renewal: "hold", dunning: "auto" });
    expect(j.kinds).toHaveLength(6);
    const by = Object.fromEntries(j.kinds.map((k: { kind: string; readiness: { state: string } }) => [k.kind, k.readiness.state]));
    expect(by.invoice_due).toBe("ready");
    expect(by.renewal_final).toBe("not_approved");
    expect(by.invoice_overdue).toBe("no_template");
    expect(j.log).toEqual([{ id: "L1", kind: "invoice_due", status: "read" }]);

    for (const t of ["whatsapp_reminder_settings", "whatsapp_reminder_templates", "whatsapp_templates", "whatsapp_reminder_log"]) {
      expect(eqs(t), t).toContainEqual(["tenant_id", "T1"]);
    }
    expect(op("whatsapp_reminder_log", "limit")!.args).toEqual([20]);
    expect(op("whatsapp_reminder_log", "order")!.args).toEqual(["created_at", { ascending: false }]);
  });

  it("a mapping that is approved but blocked by the dial says so", async () => {
    state.data = {
      whatsapp_reminder_templates: [{ kind: "renewal_upcoming", template_name: "renewal_upcoming_v1", language: "en", param_map: [], enabled: true, updated_at: "x" }],
      whatsapp_templates: [{ name: "renewal_upcoming_v1", language: "en", status: "approved", body: "Hi" }],
    };
    state.policy = { killSwitch: false, modes: { "renewal.send": "hold" } };
    const j = await (await GET(req("GET"))).json();
    expect(j.enabled).toBe(false);
    expect(j.kinds.find((k: { kind: string }) => k.kind === "renewal_upcoming").readiness.state).toBe("dial_blocks");
  });

  it("not connected when the tenant has no WhatsApp creds", async () => {
    state.creds = null;
    const j = await (await GET(req("GET"))).json();
    expect(j.connected).toBe(false);
  });
});
