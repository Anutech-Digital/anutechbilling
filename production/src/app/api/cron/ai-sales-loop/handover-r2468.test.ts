/**
 * R-2468 — a follow-up the agent handed to a PERSON is not a customer nudge.
 *
 * Before: any dispatch outcome other than "failed" counted as `nudged`. A handover sends
 * nothing to the customer — a person has to look first — so it is counted as handed_over. The
 * next step is still scheduled: shouldNudge skips it while the lead needs a person, and once the
 * flag is cleared the cadence carries on (nothing else re-arms it).
 *
 * Also: a failed quote read is "unknown", not "no hold" — the brief mentions no quotation and
 * the agent is left to run its own (fail-closed) hold check.
 *
 * The model and the dispatcher are mocked; the dispatcher's own handover is proven elsewhere.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const st = vi.hoisted(() => ({
  outcome: "handed_over" as string,
  scheduled: [] as unknown[],
  closed: [] as Record<string, unknown>[],
  quoteError: null as { message: string } | null,
  agentArgs: [] as Record<string, unknown>[],
}));

vi.mock("server-only", () => ({}));

function table(name: string) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "limit", "or", "order"]) q[m] = () => q;
  q.maybeSingle = async () => ({
    data: name === "quotes"
      ? { id: "Q-1", created_date: "2026-11-01", expires_date: "2026-11-08", status: "sent", payment_status: null }
      : null,
    error: name === "quotes" ? st.quoteError : null,
  });
  q.insert = async () => ({ data: null, error: null });
  return q;
}
const fakeAdmin = { from: (t: string) => table(t) };

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => fakeAdmin }));
vi.mock("@/lib/automation/cron-gate", () => ({
  gatedCron: (_job: string, h: (r: Request) => Promise<Response>) => h,
  cronTenantAllowed: () => true,
}));
vi.mock("@/lib/privacy/suppression.server", () => ({
  consentWithdrawnLeadIds: async () => new Set<string>(),
  suppressedEmailKeys: async () => new Set<string>(),
}));
vi.mock("@/lib/ai/seller-identity", () => ({
  sellerIdentityLookup: () => async () => ({ sellerName: "Seller Pvt Ltd" }),
}));
vi.mock("@/lib/ai/sales-loops.server", () => ({
  loadDueLoops: async () => [
    { id: "loop-1", tenantId: "T-1", leadId: "L-1", step: 1, createdAt: new Date("2026-11-01T00:00:00Z"), triggerCondition: "quote sent" },
  ],
  loadLoopLead: async () => ({
    ok: true,
    lead: {
      id: "L-1", company: "Acme", contactName: "Asha", contactEmail: "asha@acme.test", contactPhone: null,
      seats: 10, plan: "Google Workspace Business Starter", stage: "quoted", isJunk: false, requiresHumanAttention: false,
    },
  }),
  lastCustomerMessageAt: async () => null,
  closeLoop: async (a: Record<string, unknown>) => { st.closed.push(a); },
  scheduleSalesLoop: async (a: unknown) => { st.scheduled.push(a); },
}));
vi.mock("@/lib/ai/sales-agent.server", () => ({
  loadSalesCatalog: async () => [],
  runSalesAgent: async (a: Record<string, unknown>) => (st.agentArgs.push(a), {
    ok: true,
    decision: {
      action_required: "HANDOVER_TO_HUMAN",
      generated_response: { body_text: "x", whatsapp_summary: "x" },
      next_followup_loop: null,
    },
    overruled: true, overruleReason: "held figure", allowedMoney: [],
  }),
}));
vi.mock("@/lib/ai/actions/quote-dispatcher", () => ({
  dispatchSalesDecision: async () => ({
    outcome: st.outcome,
    detail: st.outcome === "handed_over" ? "A person needs to look at this lead." : "The AI sales agent answered by email.",
    followUp: null,
  }),
}));
vi.mock("@/lib/quotes/send-auto-quote", () => ({ autoQuoteHoldFor: async () => null }));

import { GET } from "./route";

const cronReq = () => new Request("https://x.invalid/api/cron/ai-sales-loop", { headers: { authorization: "Bearer s3cret" } });

beforeEach(() => {
  st.outcome = "handed_over"; st.scheduled = []; st.closed = []; st.quoteError = null; st.agentArgs = [];
  process.env.CRON_SECRET = "s3cret";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
});

describe("R-2468 — cron handover is not a nudge", () => {
  it("handed to a person → counted as handed_over, not nudged; next step still scheduled (flag skips it)", async () => {
    const res = await GET(cronReq());
    const body = await res.json() as { nudged: number; handed_over: number };
    expect(body.nudged).toBe(0);
    expect(body.handed_over).toBe(1);
    expect(st.scheduled).toHaveLength(1);
    expect(String(st.closed[0]?.outcome)).toMatch(/handed_over/);
  });

  it("control: a reply that went out is a nudge and the cadence goes on", async () => {
    st.outcome = "replied";
    const res = await GET(cronReq());
    const body = await res.json() as { nudged: number; handed_over: number };
    expect(body.nudged).toBe(1);
    expect(body.handed_over).toBe(0);
    expect(st.scheduled).toHaveLength(1);
  });

  it("quote read FAILED → hold unknown: agent left to check itself (heldQuote undefined), brief mentions no quotation", async () => {
    st.quoteError = { message: "connection reset" };
    st.outcome = "replied";
    await GET(cronReq());
    expect(st.agentArgs).toHaveLength(1);
    expect("heldQuote" in st.agentArgs[0] && st.agentArgs[0].heldQuote === undefined).toBe(true);
    expect(String(st.agentArgs[0].incoming)).toMatch(/Do not refer to a quotation/);
  });
});
