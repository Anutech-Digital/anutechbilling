/**
 * R-2039 — AI Lead Workflow runner, with the AI, the website reads and the autonomy dial mocked.
 * No real Gemini call, no network, no email: geminiJson / findContacts / mxLookup are fakes.
 *
 * Owner's path (plan, 27 Oct): press "Run AI Lead Workflow" on a lead → Fetching → Qualified →
 * Draft ready, with a 2-line email DRAFT on the timeline and nothing sent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const ai = vi.hoisted(() => ({ json: vi.fn(), cfg: vi.fn() }));
const web = vi.hoisted(() => ({ contacts: vi.fn(), persons: vi.fn(), mx: vi.fn() }));
const auto = vi.hoisted(() => ({ policy: vi.fn(), log: vi.fn() }));

vi.mock("@/lib/ai/gemini", () => ({ resolveGeminiConfig: ai.cfg, geminiJson: ai.json }));
vi.mock("@/lib/leads/lead-finder.server", () => ({ findContacts: web.contacts, attachPersons: web.persons, mxLookup: web.mx }));
vi.mock("@/lib/ai/autonomy.server", () => ({ loadAutonomyPolicy: auto.policy, logAiAction: auto.log }));

import { runLeadAiWorkflow, STALE_MS, parseQualify, parsePitch } from "./ai-workflow.server";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER_T = "22222222-2222-4222-8222-222222222222";

/* ── a tiny in-memory Supabase: enough of the query builder for the runner ─────────────── */
type Row = Record<string, unknown>;
function fakeDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = { leads: [], lead_activities: [], lead_ai_runs: [], ...seed };
  let seq = 0;
  const from = (table: string) => {
    const rows = (tables[table] ??= []);
    let op: "select" | "insert" | "update" = "select";
    let payload: Row | null = null;
    const filters: ((r: Row) => boolean)[] = [];
    let order: { col: string; asc: boolean } | null = null;
    let returning = false;
    const run = (): { data: unknown; error: { code?: string; message: string } | null } => {
      if (op === "insert") {
        const row: Row = { id: `row-${++seq}`, started_at: new Date().toISOString(), updated_at: new Date().toISOString(), finished_at: null, step: "fetching", qualify_result: null, enrich_result: null, pitch: null, draft_subject: null, error: null, next_step: null, created_at: new Date().toISOString(), ...payload };
        if (table === "lead_ai_runs" && rows.some((r) => r.tenant_id === row.tenant_id && r.lead_id === row.lead_id && r.finished_at == null)) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"lead_ai_runs_one_running_uq\"" } };
        }
        rows.push(row);
        return { data: returning ? row : null, error: null };
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === "update") { for (const r of hit) Object.assign(r, payload); return { data: null, error: null }; }
      const sorted = order ? [...hit].sort((a, b) => String(a[order!.col]).localeCompare(String(b[order!.col])) * (order!.asc ? 1 : -1)) : hit;
      return { data: sorted, error: null };
    };
    const b: Record<string, unknown> = {
      select: () => { if (op !== "select") returning = true; return b; },
      insert: (p: Row) => { op = "insert"; payload = p; return b; },
      update: (p: Row) => { op = "update"; payload = p; return b; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return b; },
      order: (col: string, o?: { ascending?: boolean }) => { order = { col, asc: o?.ascending !== false }; return b; },
      limit: () => b,
      maybeSingle: async () => { const r = run(); return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }; },
      single: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] : r.data, error: r.error }; },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  };
  return { db: { from } as never, tables };
}

function lead(over: Row = {}): Row {
  return {
    id: "L1", tenant_id: T, company: "Sharma Traders Pvt Ltd", contact_name: "Ravi Sharma", contact_email: "ravi@sharmatraders.in",
    contact_phone: null, domain: null, current_provider: null, plan: null, seats: null, expected_close_date: null,
    requirement: "Need business email for 12 staff", notes: null, state: "Delhi", is_junk: false, ai_status: null, ...over,
  };
}

const QUALIFIED = { verdict: "qualified", reasons: ["Indian SME on its own domain", "Asked for email for 12 staff"] };
const PITCH = { subject: "Business email for Sharma Traders", lines: ["Saw your team of 12 is growing in Delhi.", "We can move everyone to Google Workspace on sharmatraders.in in a day."] };

beforeEach(() => {
  vi.clearAllMocks();
  ai.cfg.mockResolvedValue({ apiKey: "test-key", model: "gemini-test", tenantId: T });
  web.contacts.mockResolvedValue({ email: "info@sharmatraders.in", phone: "+91 98100 00001", emails: ["info@sharmatraders.in"], phones: ["+91 98100 00001"], source_url: "https://sharmatraders.in/contact", checked_at: "2026-11-01T00:00:00Z", snippets: [] });
  web.persons.mockResolvedValue(undefined);
  web.mx.mockResolvedValue({ provider: "zoho", hosts: ["mx.zoho.in"] });
  auto.policy.mockResolvedValue({ killSwitch: false, modes: {} });
  auto.log.mockResolvedValue(undefined);
});

const notes = (tables: Record<string, Row[]>) => tables.lead_activities.map((a) => String(a.detail));

describe("R-2039 runLeadAiWorkflow", () => {
  it("qualified → 2-line email draft saved (draft_ready), nothing sent, every step on the timeline", async () => {
    ai.json.mockResolvedValueOnce(QUALIFIED).mockResolvedValueOnce(PITCH);
    const { db, tables } = fakeDb({ leads: [lead()] });

    const out = await runLeadAiWorkflow({ admin: db, tenantId: T, leadId: "L1", userId: "u1" });

    expect(out.kind).toBe("done");
    expect(out.status).toBe(200);
    const run = tables.lead_ai_runs[0];
    expect(run.step).toBe("draft_ready");
    expect(run.finished_at).not.toBeNull();
    expect(run.qualify_result).toEqual(QUALIFIED);
    expect(run.pitch).toBe(PITCH.lines.join("\n"));
    expect(run.draft_subject).toBe(PITCH.subject);
    expect(tables.leads[0].ai_status).toBe("draft_ready");
    expect(tables.leads[0].ai_status_at).toBeTruthy();
    const n = notes(tables);
    expect(n.some((d) => d.startsWith("AI Lead Workflow drafted an email and did NOT send it") && d.includes(PITCH.lines[1]))).toBe(true);
    expect(n.some((d) => d.startsWith("AI Lead Workflow: qualified."))).toBe(true);
    expect(auto.log).toHaveBeenCalledWith(expect.objectContaining({ action: "reply.send", outcome: "held" }));
    // two AI calls, both counted against this company (tenantId passed → monthly cap applies)
    expect(ai.json).toHaveBeenCalledTimes(2);
    for (const c of ai.json.mock.calls) expect(c[0].tenantId).toBe(T);
  });

  it("unqualified → reasons stored, NO draft and no pitch call", async () => {
    ai.json.mockResolvedValueOnce({ verdict: "unqualified", reasons: ["Student asking about a college project"] });
    const { db, tables } = fakeDb({ leads: [lead()] });

    const out = await runLeadAiWorkflow({ admin: db, tenantId: T, leadId: "L1", userId: "u1" });

    expect(out.kind).toBe("done");
    const run = tables.lead_ai_runs[0];
    expect(run.step).toBe("unqualified");
    expect(run.qualify_result).toEqual({ verdict: "unqualified", reasons: ["Student asking about a college project"] });
    expect(run.pitch).toBeNull();
    expect(ai.json).toHaveBeenCalledTimes(1);
    expect(notes(tables).some((d) => d.includes("did NOT send"))).toBe(false);
    expect(notes(tables).some((d) => d.includes("NOT qualified") && d.includes("college project"))).toBe(true);
    expect(tables.leads[0].ai_status).toBe("unqualified");
  });

  it("idempotent: a second press while a run is going returns THAT run (202) and starts nothing", async () => {
    let release!: (v: unknown) => void;
    ai.json.mockImplementationOnce(() => new Promise((r) => { release = r; })).mockResolvedValueOnce(PITCH);
    const { db, tables } = fakeDb({ leads: [lead()] });

    const first = runLeadAiWorkflow({ admin: db, tenantId: T, leadId: "L1", userId: "u1" });
    await vi.waitFor(() => expect(ai.json).toHaveBeenCalledTimes(1));
    const second = await runLeadAiWorkflow({ admin: db, tenantId: T, leadId: "L1", userId: "u2" });

    expect(second.kind).toBe("running");
    expect(second.status).toBe(202);
    expect(tables.lead_ai_runs).toHaveLength(1);
    if (second.kind === "running") expect(second.run.id).toBe(tables.lead_ai_runs[0].id);

    release(QUALIFIED);
    const done = await first;
    expect(done.kind).toBe("done");
    expect(tables.lead_ai_runs).toHaveLength(1);
    expect(ai.json).toHaveBeenCalledTimes(2); // qualify + pitch of the FIRST run only
  });

  it("a run left running by a stopped server (older than STALE_MS) is closed as failed and a new one runs", async () => {
    ai.json.mockResolvedValueOnce(QUALIFIED).mockResolvedValueOnce(PITCH);
    const old = new Date(Date.now() - STALE_MS - 60_000).toISOString();
    const { db, tables } = fakeDb({ leads: [lead()], lead_ai_runs: [{ id: "stale", tenant_id: T, lead_id: "L1", step: "fetching", started_at: old, updated_at: old, finished_at: null }] });

    const out = await runLeadAiWorkflow({ admin: db, tenantId: T, leadId: "L1", userId: "u1" });

    expect(out.kind).toBe("done");
    expect(tables.lead_ai_runs.find((r) => r.id === "stale")).toMatchObject({ step: "failed", error: expect.stringContaining("stopped without finishing") });
    expect(tables.lead_ai_runs.filter((r) => r.finished_at == null)).toHaveLength(0);
    expect(tables.lead_ai_runs.at(-1)!.step).toBe("draft_ready");
  });

  it("enrich fills ONLY empty fields and notes the source on the timeline", async () => {
    ai.json.mockResolvedValueOnce(QUALIFIED).mockResolvedValueOnce(PITCH);
    // email + name already set by a person; phone, domain and provider empty
    const { db, tables } = fakeDb({ leads: [lead({ contact_email: "ravi@sharmatraders.in", contact_name: "Ravi Sharma" })] });
    web.persons.mockImplementation(async (_ai: unknown, items: { scan: Record<string, unknown> }[]) => { items[0].scan.person = { name: "Someone Else", role: "Director", from: "page", source_url: null }; });

    await runLeadAiWorkflow({ admin: db, tenantId: T, leadId: "L1", userId: "u1" });

    const l = tables.leads[0];
    expect(l.contact_email).toBe("ravi@sharmatraders.in");       // kept — not overwritten by info@
    expect(l.contact_name).toBe("Ravi Sharma");                   // kept — not overwritten by the site's name
    expect(l.contact_phone).toBe("+91 98100 00001");              // was empty → filled
    expect(l.domain).toBe("sharmatraders.in");                    // from the business email
    expect(l.current_provider).toBe("Zoho Mail");                 // from MX
    expect(web.contacts).toHaveBeenCalledWith("sharmatraders.in", null);
    const fill = notes(tables).find((d) => d.startsWith("AI Lead Workflow filled"))!;
    expect(fill).toContain("https://sharmatraders.in/contact");
    expect(fill).toContain("phone +91 98100 00001");
    expect(fill).not.toContain("email info@");
    expect(tables.lead_ai_runs[0].enrich_result).toMatchObject({ filled: { contact_phone: "+91 98100 00001", domain: "sharmatraders.in", current_provider: "Zoho Mail" } });
  });

  it("no website and a free mailbox → nothing looked up, said on the timeline", async () => {
    ai.json.mockResolvedValueOnce(QUALIFIED).mockResolvedValueOnce(PITCH);
    const { db, tables } = fakeDb({ leads: [lead({ contact_email: "ravi.sharma@gmail.com" })] });
    await runLeadAiWorkflow({ admin: db, tenantId: T, leadId: "L1", userId: "u1" });
    expect(web.contacts).not.toHaveBeenCalled();
    expect(notes(tables).some((d) => d.includes("no website or business email"))).toBe(true);
  });

  it("usage cap reached → run failed with the cap's own sentence + next step, 429, no draft", async () => {
    const CAP = "Your company has used this month's AI limit (1000 of 1000 AI calls). It starts again on 1 Dec. To raise the limit, contact Anutech support.";
    ai.json.mockImplementation(async (a: { onCapReached?: (m: string) => void; onFailure?: (m: string) => void }) => { a.onCapReached?.(CAP); a.onFailure?.(CAP); return null; });
    const { db, tables } = fakeDb({ leads: [lead()] });

    const out = await runLeadAiWorkflow({ admin: db, tenantId: T, leadId: "L1", userId: "u1" });

    expect(out.kind).toBe("error");
    expect(out.status).toBe(429);
    if (out.kind === "error") {
      expect(out.error).toBe(CAP);
      expect(out.detail).toMatch(/limit to reset/);
    }
    const run = tables.lead_ai_runs[0];
    expect(run).toMatchObject({ step: "failed", error: CAP });
    expect(run.finished_at).not.toBeNull();               // not left "running"
    expect(run.next_step).toMatch(/limit to reset/);
    expect(tables.leads[0].ai_status).toBe("failed");
    expect(notes(tables).some((d) => d.includes("did NOT send"))).toBe(false);
  });

  it("autonomy: reply.send OFF (or the kill switch) → qualified, no draft, says how to turn it on", async () => {
    ai.json.mockResolvedValueOnce(QUALIFIED);
    auto.policy.mockResolvedValue({ killSwitch: false, modes: { "reply.send": "off" } });
    const { db, tables } = fakeDb({ leads: [lead()] });

    const out = await runLeadAiWorkflow({ admin: db, tenantId: T, leadId: "L1", userId: "u1" });

    expect(out.kind).toBe("done");
    const run = tables.lead_ai_runs[0];
    expect(run.step).toBe("qualified");
    expect(run.pitch).toBeNull();
    expect(run.next_step).toMatch(/Automation page/);
    expect(ai.json).toHaveBeenCalledTimes(1);
    expect(auto.log).toHaveBeenCalledWith(expect.objectContaining({ action: "reply.send", outcome: "skipped" }));
  });

  it("a pitch that names an amount is discarded, not saved", async () => {
    ai.json.mockResolvedValueOnce(QUALIFIED).mockResolvedValueOnce({ subject: "Offer", lines: ["Google Workspace for just ₹136 a user.", "Reply today."] });
    const { db, tables } = fakeDb({ leads: [lead()] });
    const out = await runLeadAiWorkflow({ admin: db, tenantId: T, leadId: "L1", userId: "u1" });
    expect(out.kind).toBe("error");
    expect(tables.lead_ai_runs[0]).toMatchObject({ step: "failed", pitch: null });
    expect(notes(tables).some((d) => d.includes("did NOT send"))).toBe(false);
  });

  it("no usable phone or email even after the website → unqualified without asking the AI", async () => {
    web.contacts.mockResolvedValue({ email: null, phone: null, emails: [], phones: [], source_url: null, checked_at: "x", snippets: [] });
    const { db, tables } = fakeDb({ leads: [lead({ contact_email: null, domain: "sharmatraders.in" })] });
    await runLeadAiWorkflow({ admin: db, tenantId: T, leadId: "L1", userId: "u1" });
    expect(ai.json).not.toHaveBeenCalled();
    expect(tables.lead_ai_runs[0]).toMatchObject({ step: "unqualified" });
  });

  it("another company's lead id → 404, no run, no AI", async () => {
    const { db, tables } = fakeDb({ leads: [lead({ tenant_id: OTHER_T })] });
    const out = await runLeadAiWorkflow({ admin: db, tenantId: T, leadId: "L1", userId: "u1" });
    expect(out.status).toBe(404);
    expect(tables.lead_ai_runs).toHaveLength(0);
    expect(ai.json).not.toHaveBeenCalled();
  });

  it("no AI key → 503 with the next step, no run recorded", async () => {
    ai.cfg.mockResolvedValue({ apiKey: null, model: "x", tenantId: T });
    const { db, tables } = fakeDb({ leads: [lead()] });
    const out = await runLeadAiWorkflow({ admin: db, tenantId: T, leadId: "L1", userId: "u1" });
    expect(out.status).toBe(503);
    if (out.kind === "error") expect(out.detail).toMatch(/Settings → Integrations → AI/);
    expect(tables.lead_ai_runs).toHaveLength(0);
  });
});

describe("R-2039 parsers", () => {
  it("parseQualify refuses anything but a clear verdict with reasons", () => {
    expect(parseQualify({ verdict: "maybe", reasons: ["x"] })).toBeNull();
    expect(parseQualify({ verdict: "qualified", reasons: [] })).toBeNull();
    expect(parseQualify(null)).toBeNull();
    expect(parseQualify({ verdict: "qualified", reasons: ["a", "b", "c", "d", "e"] })!.reasons).toHaveLength(4);
  });
  it("parsePitch needs a subject and two lines", () => {
    expect(parsePitch({ subject: "s", lines: ["one"] })).toBeNull();
    expect(parsePitch({ subject: "", lines: ["a", "b"] })).toBeNull();
    expect(parsePitch({ subject: "s", lines: ["a", "b", "c"] })!.lines).toEqual(["a", "b"]);
  });
});
