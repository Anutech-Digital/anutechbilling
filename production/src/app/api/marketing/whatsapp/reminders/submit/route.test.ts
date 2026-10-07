/**
 * POST /api/marketing/whatsapp/reminders/submit — starter reminder templates → Meta.
 *
 * What must hold: owner / manager only; tenant from the session, never the body; the exact
 * Graph request (URL, bearer header, UTILITY/en body with examples); Meta's status lands in
 * whatsapp_templates for the CALLER's tenant; "already exists" is fine; not connected is
 * 409 with where to go; and the access token never appears in a response or a log line.
 * fetch is mocked — the real Meta API is never called.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

type Call = { table: string; op: string; args: unknown[] };
const TOKEN = "EAAtest_SECRET_token_987";

const state = vi.hoisted(() => ({
  role: "owner" as string,
  calls: [] as Call[],
  data: {} as Record<string, unknown>,
  creds: null as unknown,
}));

vi.mock("@/lib/supabase/server", () => {
  function builder(table: string) {
    const rec = (op: string) => (...args: unknown[]) => { state.calls.push({ table, op, args }); return b; };
    const result = () => ({ data: state.data[table] ?? null, error: null });
    const b: Record<string, unknown> = {
      select: rec("select"), eq: rec("eq"), update: rec("update"), insert: rec("insert"),
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
vi.mock("@/lib/sentry", () => ({ Sentry: { captureException: vi.fn() } }));

import { POST } from "./route";

const req = (body?: unknown) =>
  new Request("https://x.invalid/api/marketing/whatsapp/reminders/submit", {
    method: "POST", body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as NextRequest;

const ops = (table: string, o: string) => state.calls.filter((c) => c.table === table && c.op === o);
const eqs = (table: string) => ops(table, "eq").map((c) => c.args);

let fetchMock: ReturnType<typeof vi.fn>;
let logs: ReturnType<typeof vi.spyOn>[];
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  state.role = "owner";
  state.calls = [];
  state.data = {};
  state.creds = { accessToken: TOKEN, phoneNumberId: "P1", businessAccountId: "WABA1" };
  fetchMock = vi.fn(async () => reply(200, { id: "M1", status: "PENDING", category: "UTILITY" }));
  vi.stubGlobal("fetch", fetchMock);
  logs = (["error", "warn", "log", "info"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function tokenNowhere(resText: string) {
  expect(resText).not.toContain(TOKEN);
  for (const s of logs) for (const call of s.mock.calls) expect(JSON.stringify(call)).not.toContain(TOKEN);
}

describe("success", () => {
  it("submits all six starters with the exact Graph request and writes PENDING as submitted", async () => {
    const res = await POST(req());
    const text = await res.text();
    expect(res.status).toBe(200);
    const j = JSON.parse(text);
    expect(j.submitted).toBe(6);
    expect(j.results).toHaveLength(6);
    expect(j.results[0]).toEqual({ kind: "renewal_upcoming", name: "renewal_upcoming_v1", ok: true, status: "submitted" });

    expect(fetchMock).toHaveBeenCalledTimes(6);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v18.0/WABA1/message_templates");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ name: "renewal_upcoming_v1", language: "en", category: "UTILITY" });
    expect(body.components).toHaveLength(1);
    expect(body.components[0].type).toBe("BODY");
    expect(body.components[0].example.body_text).toEqual([["Rahul", "Google Workspace Business Starter", "15 Oct 2026", "₹1,180", "https://example.com/pay/INV-2026-0142", "Anutech"]]);

    const ins = ops("whatsapp_templates", "insert");
    expect(ins).toHaveLength(6);
    expect(ins[0].args[0]).toMatchObject({ tenant_id: "T1", name: "renewal_upcoming_v1", language: "en", category: "UTILITY", status: "submitted", meta_id: "M1", created_by: "U1" });
    tokenNowhere(text);
  });

  it("skips starters already approved / pending and only re-submits the rest, updating an existing draft row", async () => {
    state.data.whatsapp_templates = [
      { id: "R1", name: "renewal_upcoming_v1", language: "en", status: "approved" },
      { id: "R2", name: "invoice_due_v1", language: "en", status: "submitted" },
      { id: "R3", name: "invoice_final_v1", language: "en", status: "draft" },
    ];
    fetchMock.mockImplementation(async () => reply(200, { id: "M9", status: "APPROVED", category: "UTILITY" }));
    const j = await (await POST(req())).json();
    expect(j.results.map((r: { name: string }) => r.name)).toEqual(["renewal_today_v1", "renewal_grace_v1", "invoice_overdue_v1", "invoice_final_v1"]);
    const up = ops("whatsapp_templates", "update");
    expect(up).toHaveLength(1);
    expect(up[0].args[0]).toMatchObject({ status: "approved", meta_id: "M9" });
    expect(eqs("whatsapp_templates")).toContainEqual(["id", "R3"]);
  });

  it("only the asked kinds; an unknown kind is 400 and Meta is not called", async () => {
    const j = await (await POST(req({ kinds: ["invoice_final"] }))).json();
    expect(j.results.map((r: { kind: string }) => r.kind)).toEqual(["invoice_final"]);
    fetchMock.mockClear();
    expect((await POST(req({ kinds: ["birthday"] }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("duplicate and failures", () => {
  it("'already exists' on Meta is ok — pehle se submit hai, nothing written", async () => {
    fetchMock.mockImplementation(async () => reply(400, { error: { message: "Message template already exists", code: 100, error_subcode: 2388024 } }));
    const j = await (await POST(req({ kinds: ["invoice_due"] }))).json();
    expect(j.results).toEqual([{ kind: "invoice_due", name: "invoice_due_v1", ok: true, status: null, error: expect.stringMatching(/pehle se submit hai/i) }]);
    expect(ops("whatsapp_templates", "insert")).toHaveLength(0);
  });

  it("a Meta refusal is per-template, Hinglish, and carries neither the token nor a 5xx", async () => {
    fetchMock.mockImplementation(async () => reply(400, { error: { message: `Invalid parameter for ${TOKEN}`, code: 100 } }));
    const res = await POST(req({ kinds: ["invoice_due", "invoice_final"] }));
    const text = await res.text();
    expect(res.status).toBe(200);
    const j = JSON.parse(text);
    expect(j.submitted).toBe(0);
    expect(j.results.every((r: { ok: boolean; error: string }) => !r.ok && /Meta rejected the template/.test(r.error))).toBe(true);
    tokenNowhere(text);
  });

  it("a network failure is reported per template", async () => {
    fetchMock.mockImplementation(async () => { throw new Error(`connect ECONNRESET ${TOKEN}`); });
    const res = await POST(req({ kinds: ["invoice_due"] }));
    const text = await res.text();
    expect(JSON.parse(text).results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/network/) });
    tokenNowhere(text);
  });
});

describe("not connected", () => {
  it.each([[null], [{ accessToken: TOKEN, phoneNumberId: "P1", businessAccountId: null }]])("409 with where to go, Meta never called (%#)", async (creds) => {
    state.creds = creds;
    const res = await POST(req());
    const text = await res.text();
    expect(res.status).toBe(409);
    expect(JSON.parse(text).error).toMatch(/Pehle Settings → Integrations mein WhatsApp Business connect karo/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);
    tokenNowhere(text);
  });
});

describe("roles and tenant isolation", () => {
  it.each(["sales", "billing", "support", "accountant"])("%s gets 403, nothing called", async (role) => {
    state.role = role;
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/owner \/ manager/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);
  });

  it("manager is allowed", async () => {
    state.role = "manager";
    expect((await POST(req({ kinds: ["invoice_due"] }))).status).toBe(200);
  });

  it("reads and writes only the caller's tenant, ignoring a tenant_id in the body", async () => {
    state.data.whatsapp_templates = [{ id: "R3", name: "invoice_final_v1", language: "en", status: "draft" }];
    await POST(req({ kinds: ["invoice_due", "invoice_final"], tenant_id: "OTHER" }));
    expect(eqs("whatsapp_templates")).toContainEqual(["tenant_id", "T1"]);
    expect(JSON.stringify(state.calls)).not.toContain("OTHER");
    expect(ops("whatsapp_templates", "insert")[0].args[0]).toMatchObject({ tenant_id: "T1" });
    // the update of an existing row is pinned to the tenant too, not only to its id
    expect(eqs("whatsapp_templates").filter((a) => a[0] === "tenant_id")).toHaveLength(2);
  });
});
