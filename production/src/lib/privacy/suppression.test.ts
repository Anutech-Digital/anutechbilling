/**
 * R-2013 (DPDP, part D): a confirmed "withdraw my consent" stops the automated messages.
 *   - lib helpers: who is suppressed / withdrawn (fail closed on a failed read);
 *   - birthday greetings: a suppressed address gets no greeting (mailer mocked — nothing sent);
 *   - AI sales follow-up: a lead whose newest marketing row is 'withdrawn' gets no AI run and
 *     its follow-up row is closed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const st = vi.hoisted(() => ({
  suppressions: [] as { tenant_id: string; email: string }[],
  consent: [] as { tenant_id: string; lead_id: string; purpose: string; choice: string; created_at: string }[],
  suppressionError: null as null | { message: string },
  contacts: [] as Record<string, unknown>[],
  sends: [] as Record<string, unknown>[],
  loops: [] as Record<string, unknown>[],
  closed: [] as Record<string, unknown>[],
  agentRuns: 0,
}));

vi.mock("server-only", () => ({}));

/** A tiny query builder over the fake tables: select / eq / in / order / or / range / maybeSingle / upsert. */
function table(name: string) {
  const filters: Array<(r: Record<string, unknown>) => boolean> = [];
  const q: Record<string, unknown> = {};
  const rows = () => {
    if (name === "email_suppressions" && st.suppressionError) return { data: null, error: st.suppressionError };
    const src = name === "email_suppressions" ? st.suppressions : name === "consent_events" ? st.consent
      : name === "contacts" ? st.contacts : [];
    return { data: (src as Record<string, unknown>[]).filter((r) => filters.every((f) => f(r))), error: null };
  };
  Object.assign(q, {
    select: () => q,
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
    in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])); return q; },
    or: () => q,
    order: (c: string, o?: { ascending?: boolean }) => {
      const r = rows();
      if (r.data && o?.ascending === false) r.data.sort((a, b) => String(b[c]).localeCompare(String(a[c])));
      return Object.assign(Promise.resolve(r), q, { range: () => Promise.resolve(r) });
    },
    range: () => Promise.resolve(rows()),
    maybeSingle: async () => ({ data: name === "tenants" ? { name: "Acme", email: "acme@example.in" } : null, error: null }),
    upsert: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: "claim-1" }, error: null }) }) }),
    update: () => ({ eq: async () => ({ error: null }) }),
    delete: () => ({ eq: async () => ({ error: null }) }),
    then: (res: (v: unknown) => unknown) => Promise.resolve(rows()).then(res),
  });
  return q;
}
const fakeAdmin = { from: (t: string) => table(t) };

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => fakeAdmin }));
vi.mock("@/lib/automation/cron-gate", () => ({
  gatedCron: (_job: string, h: (r: Request) => Promise<Response>) => h,
  cronTenantAllowed: () => true,
  isCronDryRun: () => false,
  noteWouldSend: () => {},
}));
vi.mock("@/lib/messaging", () => ({
  sendCustomerEmail: vi.fn(async (m: Record<string, unknown>) => { st.sends.push(m); return { status: "sent", providerId: "p1", errorMessage: null }; }),
}));
vi.mock("@/lib/email/send", () => ({ isEmailConfigured: () => true }));
vi.mock("@/lib/ai/sales-loops.server", () => ({
  loadDueLoops: async () => st.loops,
  loadLoopLead: async () => ({ ok: true, lead: { id: "L-W", contactEmail: "wd@example.in", stage: "quoted", isJunk: false, requiresHumanAttention: false } }),
  lastCustomerMessageAt: async () => null,
  closeLoop: async (c: Record<string, unknown>) => { st.closed.push(c); },
  scheduleSalesLoop: async () => {},
}));
vi.mock("@/lib/ai/sales-agent.server", () => ({
  runSalesAgent: async () => { st.agentRuns++; throw new Error("the agent must not run"); },
  loadSalesCatalog: async () => [],
}));
vi.mock("@/lib/ai/actions/quote-dispatcher", () => ({ dispatchSalesDecision: async () => ({ outcome: "sent", detail: "x" }) }));

import { suppressedEmailKeys, consentWithdrawnLeadIds, suppressionKey } from "./suppression.server";
import { GET as birthday } from "@/app/api/cron/birthday-greetings/route";
import { GET as salesLoop } from "@/app/api/cron/ai-sales-loop/route";

const T = "T-1";
const today = () => {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return `1990-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
};
const cronReq = () => new Request("https://x.invalid/api/cron", { headers: { authorization: "Bearer s3cret" } });

beforeEach(() => {
  st.suppressions = []; st.consent = []; st.suppressionError = null; st.contacts = []; st.sends = [];
  st.loops = []; st.closed = []; st.agentRuns = 0;
  process.env.CRON_SECRET = "s3cret";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
});

describe("helpers", () => {
  it("suppressedEmailKeys matches the address in ITS company only, any case", async () => {
    st.suppressions = [{ tenant_id: T, email: "asha@example.in" }, { tenant_id: "T-2", email: "ravi@example.in" }];
    const keys = await suppressedEmailKeys(fakeAdmin as never, [
      { tenantId: T, email: "Asha@Example.in" }, { tenantId: T, email: "ravi@example.in" }, { tenantId: T, email: null },
    ]);
    expect([...keys]).toEqual([suppressionKey(T, "asha@example.in")]);
  });

  it("a failed suppression read throws (callers send nothing)", async () => {
    st.suppressionError = { message: "down" };
    await expect(suppressedEmailKeys(fakeAdmin as never, [{ tenantId: T, email: "a@example.in" }])).rejects.toThrow(/suppression list/);
  });

  it("consentWithdrawnLeadIds: only leads whose NEWEST marketing row is 'withdrawn'", async () => {
    st.consent = [
      { tenant_id: T, lead_id: "L-1", purpose: "marketing", choice: "granted", created_at: "2026-11-01T10:00:00Z" },
      { tenant_id: T, lead_id: "L-1", purpose: "marketing", choice: "withdrawn", created_at: "2026-11-02T10:00:00Z" },
      { tenant_id: T, lead_id: "L-2", purpose: "marketing", choice: "withdrawn", created_at: "2026-11-01T10:00:00Z" },
      { tenant_id: T, lead_id: "L-2", purpose: "marketing", choice: "granted", created_at: "2026-11-02T10:00:00Z" },
    ];
    expect([...await consentWithdrawnLeadIds(fakeAdmin as never, T, ["L-1", "L-2", "L-3"])]).toEqual(["L-1"]);
  });
});

describe("birthday greetings skip people who withdrew consent", () => {
  it("greets the others, not the suppressed address", async () => {
    st.contacts = [
      { id: "C-1", tenant_id: T, full_name: "Asha Verma", email: "asha@example.in", birthday: today(), anniversary: null },
      { id: "C-2", tenant_id: T, full_name: "Ravi", email: "ravi@example.in", birthday: today(), anniversary: null },
    ];
    st.suppressions = [{ tenant_id: T, email: "asha@example.in" }];
    const res = await birthday(cronReq());
    const body = await res.json();
    expect(st.sends.map((s) => s.to)).toEqual(["ravi@example.in"]);
    expect(body).toMatchObject({ matched: 2, sent: 1, skipped_opted_out: 1 });
  });

  it("a failed suppression read sends no greeting at all", async () => {
    st.contacts = [{ id: "C-2", tenant_id: T, full_name: "Ravi", email: "ravi@example.in", birthday: today(), anniversary: null }];
    st.suppressionError = { message: "down" };
    const res = await birthday(cronReq());
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(st.sends).toEqual([]);
  });
});

describe("AI sales follow-up skips a lead who withdrew consent", () => {
  it("no agent run, the follow-up row is closed with the reason", async () => {
    st.loops = [{ id: "loop-1", tenantId: T, leadId: "L-W", step: 1, createdAt: new Date() }];
    st.consent = [{ tenant_id: T, lead_id: "L-W", purpose: "marketing", choice: "withdrawn", created_at: "2026-11-02T10:00:00Z" }];
    const res = await salesLoop(cronReq());
    const body = await res.json();
    expect(st.agentRuns).toBe(0);
    expect(body).toMatchObject({ due: 1, skipped: 1, nudged: 0 });
    expect(st.closed[0]).toMatchObject({ id: "loop-1", outcome: expect.stringMatching(/withdrew consent/) });
  });
});
