/**
 * R-2040 — "Approve & send" on an AI Lead Workflow draft goes through THIS route (the same one as
 * any lead email). Pinned:
 *   - an aiRunId of another company, of another lead, or of a draft already sent is refused (409)
 *     BEFORE the mailer is called — nothing is sent, nothing is marked;
 *   - the run becomes "sent" (and leads.ai_status = sent) only AFTER the mailer said "sent";
 *     a failed or stubbed send leaves it draft_ready;
 *   - without aiRunId the route behaves exactly as before (no run touched).
 * The mailer is mocked — no real email leaves.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER_T = "22222222-2222-4222-8222-222222222222";
const RUN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_TENANT_RUN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_LEAD_RUN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

type Row = Record<string, unknown>;
const s = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  order: [] as string[],
  send: vi.fn(),
}));

/* A tiny in-memory Supabase: select / insert / update with eq filters, enough for the route. */
function from(table: string) {
  const rows = (s.tables[table] ??= []);
  let op: "select" | "insert" | "update" = "select";
  let payload: Row | null = null;
  let returning = false;
  const filters: ((r: Row) => boolean)[] = [];
  const run = () => {
    if (op === "insert") { rows.push({ ...payload }); return { data: null, error: null }; }
    const hit = rows.filter((r) => filters.every((f) => f(r)));
    if (op === "update") {
      for (const r of hit) Object.assign(r, payload);
      s.order.push(`update:${table}`);
      return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
    }
    return { data: hit, error: null };
  };
  const b: Record<string, unknown> = {
    select: () => { if (op !== "select") returning = true; return b; },
    insert: (p: Row) => { op = "insert"; payload = p; return b; },
    update: (p: Row) => { op = "update"; payload = p; return b; },
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; },
    maybeSingle: async () => { const r = run(); return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }; },
    then: (ok: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, rej),
  };
  return b;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "U1", email: "u1@example.invalid" } } }) },
    from: (t: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: t === "users" ? { tenant_id: T, role: "sales" } : null, error: null });
      return q;
    },
  }),
  createAdminClientFor: () => ({ from }),
}));
vi.mock("@/lib/sentry", () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock("@/lib/messaging", () => ({ sendCustomerEmail: (...a: unknown[]) => { s.order.push("send"); return s.send(...a); } }));
/* The runner's AI/website helpers are not used by the two R-2040 helpers — kept off the network. */
vi.mock("@/lib/ai/gemini", () => ({ resolveGeminiConfig: vi.fn(), geminiJson: vi.fn() }));
vi.mock("@/lib/leads/lead-finder.server", () => ({ findContacts: vi.fn(), attachPersons: vi.fn(), mxLookup: vi.fn() }));
vi.mock("@/lib/ai/autonomy.server", () => ({ loadAutonomyPolicy: vi.fn(), logAiAction: vi.fn() }));

import { POST } from "./route";

const post = (body: Record<string, unknown>) =>
  POST(new NextRequest("http://x/api/leads/L1/email", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    { params: Promise.resolve({ id: "L1" }) });

const run = (id: string) => s.tables.lead_ai_runs.find((r) => r.id === id)!;
const lead = () => s.tables.leads.find((r) => r.id === "L1")!;

beforeEach(() => {
  vi.clearAllMocks();
  s.order = [];
  s.tables = {
    leads: [
      { id: "L1", tenant_id: T, company: "Acme", contact_email: "buyer@example.invalid", ai_status: "draft_ready" },
      { id: "L2", tenant_id: T, company: "Other lead", contact_email: "x@example.invalid", ai_status: "draft_ready" },
    ],
    lead_ai_runs: [
      { id: RUN, tenant_id: T, lead_id: "L1", step: "draft_ready" },
      { id: OTHER_TENANT_RUN, tenant_id: OTHER_T, lead_id: "L1", step: "draft_ready" },
      { id: OTHER_LEAD_RUN, tenant_id: T, lead_id: "L2", step: "draft_ready" },
    ],
    inbound_emails: [],
    lead_activities: [],
  };
  s.send.mockResolvedValue({ status: "sent", providerId: "p1", provider: "gmail" });
});

const draft = { subject: "Quick idea for Acme", body: "Line one.\nLine two (edited by me).", aiRunId: RUN };

describe("R-2040 POST /api/leads/[id]/email with an AI draft", () => {
  it("sends the approved (edited) text, then marks the run and the lead 'sent'", async () => {
    const res = await post(draft);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, aiRunSent: true });
    expect(s.send).toHaveBeenCalledWith(expect.objectContaining({ to: "buyer@example.invalid", subject: "Quick idea for Acme", text: "Line one.\nLine two (edited by me).", route: { tenantId: T } }));
    expect(run(RUN).step).toBe("sent");
    expect(lead().ai_status).toBe("sent");
    /* marked only AFTER the mailer: the first lead_ai_runs update comes after "send" */
    expect(s.order.indexOf("send")).toBeLessThan(s.order.indexOf("update:lead_ai_runs"));
    expect(s.tables.lead_activities.some((a) => String(a.detail).includes("approved the email draft"))).toBe(true);
  });

  it("another company's run id → 409, nothing sent, nothing marked", async () => {
    const res = await post({ ...draft, aiRunId: OTHER_TENANT_RUN });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Nothing was sent/);
    expect(s.send).not.toHaveBeenCalled();
    expect(run(OTHER_TENANT_RUN).step).toBe("draft_ready");
    expect(lead().ai_status).toBe("draft_ready");
  });

  it("another lead's run id → 409, nothing sent, that run untouched", async () => {
    const res = await post({ ...draft, aiRunId: OTHER_LEAD_RUN });
    expect(res.status).toBe(409);
    expect(s.send).not.toHaveBeenCalled();
    expect(run(OTHER_LEAD_RUN).step).toBe("draft_ready");
  });

  it("a draft already sent → 409, never mailed twice", async () => {
    run(RUN).step = "sent";
    const res = await post(draft);
    expect(res.status).toBe(409);
    expect(s.send).not.toHaveBeenCalled();
  });

  it("the mailer refuses → its reason comes back (502) and the run stays draft_ready", async () => {
    s.send.mockResolvedValue({ status: "failed", providerId: null, errorMessage: "Not sent — customer messages are switched off for this company.", provider: "stub" });
    const res = await post(draft);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("Not sent — customer messages are switched off for this company.");
    expect(run(RUN).step).toBe("draft_ready");
    expect(lead().ai_status).toBe("draft_ready");
  });

  it("a practice (stubbed) send reached nobody → run stays draft_ready, aiRunSent false", async () => {
    s.send.mockResolvedValue({ status: "stubbed", providerId: null, provider: "stub" });
    const res = await post(draft);
    expect(await res.json()).toMatchObject({ ok: true, stub: true, aiRunSent: false });
    expect(run(RUN).step).toBe("draft_ready");
  });

  it("an aiRunId that is not a uuid → 400 before anything is read or sent", async () => {
    const res = await post({ ...draft, aiRunId: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(s.send).not.toHaveBeenCalled();
  });

  it("without aiRunId it is the plain lead email: sent, no run touched, no aiRunSent field", async () => {
    const res = await post({ subject: "Hello", body: "Hi there" });
    const json = await res.json();
    expect(json).toMatchObject({ ok: true });
    expect(json).not.toHaveProperty("aiRunSent");
    expect(run(RUN).step).toBe("draft_ready");
  });
});
