/**
 * R-1470 — the rest of R-732: each mutating route below admits the roles that already do that job
 * in the app (the page that calls it, nav.ts; ACTION_ROLES; PERMISSIONS) and refuses the rest
 * with 403 BEFORE any data is read past the caller's own users row, anything is written, an AI
 * model is called or a message is sent.
 *
 * One fake Supabase client for every route: `users` answers with the caller's row (role set per
 * case), every other table answers empty (or `rows[table]`), and every write / rpc is recorded.
 * Allowed role → the answer is anything but the gate's refusal (the route may still 400 / 404 on
 * the empty fake data — that is past the gate). Denied role → 403, no write, no rpc, no AI, no
 * message, no outbound fetch, and no table read except `users` (plus `readsBeforeGate`).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";

const state = vi.hoisted(() => ({
  role: "owner" as string | null,
  reads: [] as string[],
  writes: [] as string[],
  rows: {} as Record<string, Record<string, unknown> | null>,
}));

const ai = vi.hoisted(() => ({ json: vi.fn(), text: vi.fn() }));
const msg = vi.hoisted(() => ({ email: vi.fn(), wa: vi.fn() }));

vi.mock("@/lib/supabase/server", () => {
  const WRITES = new Set(["insert", "update", "upsert", "delete"]);
  const chain = (table: string): unknown => {
    const result = () => {
      if (table === "users") {
        return { data: { id: USER_ID, tenant_id: TENANT, role: state.role, is_active: true, email: "t@example.test", full_name: "Test User", employee_id: null }, error: null };
      }
      return { data: state.rows[table] ?? null, error: null, count: 0 };
    };
    const self: unknown = new Proxy({}, {
      get(_t, prop: string | symbol) {
        if (prop === "then") {
          return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
        }
        if (prop === "single" || prop === "maybeSingle") return async () => result();
        return (..._args: unknown[]) => {
          if (typeof prop === "string" && WRITES.has(prop)) state.writes.push(`${table}.${prop}`);
          return self;
        };
      },
    });
    return self;
  };
  const client = () => new Proxy({}, {
    get(_t, prop: string | symbol) {
      if (prop === "auth") {
        return { getUser: async () => ({ data: { user: { id: USER_ID, email: "t@example.test" } }, error: null }) };
      }
      if (prop === "from") return (t: string) => { state.reads.push(t); return chain(t); };
      if (prop === "rpc") return (n: string) => { state.writes.push(`rpc:${n}`); return chain(`rpc:${n}`); };
      if (prop === "then") return undefined;
      return () => chain(String(prop));
    },
  });
  return { createClient: client, createAdminClient: client, createAdminClientFor: client };
});

vi.mock("@/lib/ai/gemini", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/gemini")>()),
  resolveGeminiConfig: async () => ({ apiKey: "test-key", model: "test-model", source: "env" }),
  geminiJson: ai.json,
  geminiGroundedText: ai.text,
}));

vi.mock("@/lib/messaging", async (orig) => ({
  ...(await orig<typeof import("@/lib/messaging")>()),
  sendCustomerEmail: msg.email,
  sendCustomerWhatsApp: msg.wa,
}));

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Mod = Record<string, unknown>;

interface Case {
  route: string;
  load: () => Promise<Mod>;
  method?: "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** Roles that do this job in the app today. */
  allow: (string | null)[];
  /** Roles that must get 403. */
  deny: (string | null)[];
  /** Tables the gate itself has to read (e.g. the report's reporter). */
  readsBeforeGate?: string[];
  rows?: Record<string, Record<string, unknown> | null>;
}

const CASES: Case[] = [
  { route: "ai/classify-junk", load: () => import("./ai/classify-junk/route"), body: { leadIds: [ID] }, allow: ["sales", "sales_senior", "manager"], deny: ["support", "billing", "accountant", "delivery", "partner_agent", null] },
  { route: "ai/data-entry", load: () => import("./ai/data-entry/route"), body: { text: "Ravi 9876543210 needs 5 seats" }, allow: ["owner", "sales", "billing"], deny: ["support", "accountant", "delivery", "partner_agent"] },
  { route: "ai/draft-followup", load: () => import("./ai/draft-followup/route"), body: { customerId: ID, channel: "whatsapp", purpose: "renewal" }, allow: ["owner", "billing", "support", "accountant"], deny: ["sales", "delivery", "partner_agent"] },
  { route: "ai/extract-bill", load: () => import("./ai/extract-bill/route"), body: { fileBase64: "A".repeat(40), mimeType: "application/pdf" }, allow: ["accountant", "billing", "delivery", "sales"], deny: ["support", "partner_agent", null] },
  { route: "ai/extract-statement", load: () => import("./ai/extract-statement/route"), body: { fileBase64: "A".repeat(40), mimeType: "application/pdf" }, allow: ["owner", "accountant", "billing"], deny: ["sales", "support", "delivery", "partner_agent"] },
  { route: "ai/generate-assessment", load: () => import("./ai/generate-assessment/route"), body: { topic: "GST" }, allow: ["owner", "manager"], deny: ["sales", "billing", "accountant", "support", "partner_agent"] },
  { route: "ai/help", load: () => import("./ai/help/route"), body: { messages: [{ role: "user", text: "help" }] }, allow: ["sales", "partner_agent", "accountant"], deny: [null, "made_up"] },
  { route: "ai/plan-project", load: () => import("./ai/plan-project/route"), body: { title: "Website" }, allow: ["delivery", "sales", "billing"], deny: ["support", "accountant", "partner_agent"] },
  { route: "ai/scan-visiting-card", load: () => import("./ai/scan-visiting-card/route"), body: { text: "Ravi Kumar, Acme Pvt Ltd, 9876543210" }, allow: ["sales", "accountant", "delivery"], deny: ["support", "partner_agent"] },
  { route: "campaigns/ai-generate", load: () => import("./campaigns/ai-generate/route"), body: { prompt: "Diwali offer for SMEs" }, allow: ["owner", "manager"], deny: ["sales", "billing", "support", "partner_agent"] },
  { route: "contacts/[id]/promote", load: () => import("./contacts/[id]/promote/route"), body: {}, allow: ["sales", "manager"], deny: ["billing", "support", "accountant", "partner_agent"] },
  { route: "feedback/triage (someone else's report)", load: () => import("./feedback/triage/route"), body: { feedbackId: ID }, rows: { feedback: { id: ID, tenant_id: TENANT, reported_by: "someone-else", status: "open" } }, readsBeforeGate: ["feedback"], allow: ["owner", "manager"], deny: ["sales", "billing", "support", "partner_agent"] },
  { route: "feedback/triage (own report)", load: () => import("./feedback/triage/route"), body: { feedbackId: ID }, rows: { feedback: { id: ID, tenant_id: TENANT, reported_by: USER_ID, status: "open" } }, readsBeforeGate: ["feedback"], allow: ["sales", "support", "partner_agent"], deny: [null] },
  { route: "gstin/verify", load: () => import("./gstin/verify/route"), body: { gstin: "27AAPFU0939F1ZV" }, allow: ["owner", "accountant", "sales", "billing"], deny: ["support", "partner_agent"] },
  { route: "inbound-emails/[id]/convert", load: () => import("./inbound-emails/[id]/convert/route"), allow: ["sales", "manager"], deny: ["billing", "support", "accountant", "partner_agent"] },
  { route: "inbound-emails/[id]/reply", load: () => import("./inbound-emails/[id]/reply/route"), body: { subject: "Re: seats", body: "Hello" }, allow: ["sales", "owner"], deny: ["billing", "support", "partner_agent"] },
  { route: "inbound-emails/[id]/state", load: () => import("./inbound-emails/[id]/state/route"), method: "PATCH", body: { read: true }, allow: ["sales", "sales_senior"], deny: ["billing", "accountant", "partner_agent"] },
  { route: "leads/[id]/draft-reply", load: () => import("./leads/[id]/draft-reply/route"), body: {}, allow: ["sales", "manager"], deny: ["support", "billing", "partner_agent"] },
  { route: "leads/google-import", load: () => import("./leads/google-import/route"), body: { rows: [{ fullName: "Ravi" }] }, allow: ["owner", "manager"], deny: ["sales", "sales_senior", "billing", "partner_agent"] },
  { route: "leads/start-trial", load: () => import("./leads/start-trial/route"), body: { fullName: "Ravi K", companyName: "Acme", email: "r@example.test", phone: "9876543210", seats: 2, domain: "acme.example" }, allow: ["sales", "owner"], deny: ["billing", "support", "partner_agent"] },
  { route: "marketing/review-request", load: () => import("./marketing/review-request/route"), body: { customerId: ID }, allow: ["owner", "manager"], deny: ["sales", "billing", "support"] },
  { route: "my-advances", load: () => import("./my-advances/route"), body: { advance_id: ID, category: "Travel", amount: 100, expense_date: "2026-10-01" }, allow: ["delivery", "sales", "owner"], deny: ["partner_agent", null] },
  { route: "quotes/[id]/send", load: () => import("./quotes/[id]/send/route"), body: { to: "c@example.test" }, allow: ["sales", "manager"], deny: ["billing", "support", "accountant", "partner_agent"] },
  { route: "renewals/send-now", load: () => import("./renewals/send-now/route"), body: { subscription_id: ID }, allow: ["support", "billing", "manager"], deny: ["sales", "accountant", "delivery", "partner_agent"] },
  { route: "support/call-request", load: () => import("./support/call-request/route"), body: { customer_id: ID }, allow: ["support", "delivery", "billing"], deny: ["sales", "accountant", "partner_agent"] },
  { route: "voice/whatsapp-note", load: () => import("./voice/whatsapp-note/route"), body: { customerId: ID }, allow: ["sales", "billing", "support"], deny: ["partner_agent", null] },
];

/** Route modules imported once in beforeAll (R-1591). */
const loaded = new Map<Case, Mod>();

const fetchMock = vi.fn(async () => { throw new Error("no network in tests"); });

beforeEach(() => {
  state.reads = [];
  state.writes = [];
  state.rows = {};
  ai.json.mockReset().mockResolvedValue(null);
  ai.text.mockReset().mockResolvedValue(null);
  msg.email.mockReset().mockResolvedValue({ status: "stubbed" });
  msg.wa.mockReset().mockResolvedValue({ status: "stubbed" });
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function call(c: Case, role: string | null): Promise<{ status: number; error: string | null }> {
  state.role = role;
  state.rows = { ...(c.rows ?? {}) };
  const mod = loaded.get(c) ?? (await c.load());
  const method = c.method ?? "POST";
  const handler = mod[method] as Handler;
  const req = new NextRequest(`https://app.example.test/api/${c.route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: c.body === undefined ? undefined : JSON.stringify(c.body),
  });
  try {
    const res = await handler(req, { params: Promise.resolve({ id: ID, connectionId: ID }) });
    const json = (await res.clone().json().catch(() => ({}))) as { error?: unknown };
    return { status: res.status, error: typeof json.error === "string" ? json.error : null };
  } catch {
    // A throw on the empty fake data happens after the gate — the gate answers, it never throws.
    return { status: 500, error: null };
  }
}

/** The refusals the gates answer with (withRoute's / mayOpenPage's, and mayDo's forbiddenMessage). */
const isGateRefusal = (r: { status: number; error: string | null }) =>
  r.status === 403 && !!r.error && (/role is not allowed/.test(r.error) || /^Only .+ can /.test(r.error));

describe("R-1470: mutating routes refuse roles that do not do that job", () => {
  /* R-1591 (18 Oct 2026): the 26 route modules (AI / messaging / Prisma graphs) used to be imported
     inside each case's FIRST test, under the 5 s default — a cold import in a parallel full run went
     past it (inbound-emails/[id]/reply: 5014 ms even alone). Import them once here with a hook-only
     timeout; the tests themselves only run the handler, still under the 5 s default. */
  beforeAll(async () => {
    for (const c of CASES) loaded.set(c, await c.load());
  }, 120_000);

  for (const c of CASES) {
    for (const role of c.allow) {
      it(`${c.route}: ${role ?? "no role"} passes the gate`, async () => {
        const r = await call(c, role);
        expect(isGateRefusal(r), `${c.route} refused ${role}: ${r.status} ${r.error}`).toBe(false);
      });
    }
    for (const role of c.deny) {
      it(`${c.route}: ${role ?? "no role"} → 403, nothing read, written, generated or sent`, async () => {
        const r = await call(c, role);
        expect(r.status).toBe(403);
        expect(isGateRefusal(r), String(r.error)).toBe(true);
        expect(state.writes).toEqual([]);
        const allowed = new Set(["users", ...(c.readsBeforeGate ?? [])]);
        expect(state.reads.filter((t) => !allowed.has(t))).toEqual([]);
        expect(ai.json).not.toHaveBeenCalled();
        expect(ai.text).not.toHaveBeenCalled();
        expect(msg.email).not.toHaveBeenCalled();
        expect(msg.wa).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
      });
    }
  }
});
