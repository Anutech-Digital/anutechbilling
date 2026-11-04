/**
 * R-2467 — the AI sales follow-up cron checks the held-quote rule (R-2460) before the agent
 * writes.
 *
 * R-2460 made a HELD draft (no place of supply / needs approval) unstatable: ingest passes the
 * hold to the agent, and runSalesAgentForLead checks the lead's newest draft itself. This cron
 * calls runSalesAgent directly, so without its own check a scheduled follow-up ("your quote
 * expires on …") ran with no hold at all and could name the held draft's price.
 *
 * The model is mocked: what matters here is that the cron hands the hold over. What the agent
 * then does with it (prompt lines, a held figure → HANDOVER_TO_HUMAN) is proven in
 * lib/ai/held-quote-agent-r2460.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const st = vi.hoisted(() => ({
  quote: null as Record<string, unknown> | null,
  agentArgs: [] as Record<string, unknown>[],
  dispatched: [] as Record<string, unknown>[],
  holdCalls: [] as unknown[],
  hold: null as unknown,
  quoteOrder: [] as string[],
}));

vi.mock("server-only", () => ({}));

function table(name: string) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "limit", "or"]) q[m] = () => q;
  q.order = (c: string, o?: { ascending?: boolean }) => {
    if (name === "quotes") st.quoteOrder.push(`${c} ${o?.ascending === false ? "desc" : "asc"}`);
    return q;
  };
  q.maybeSingle = async () => ({ data: name === "quotes" ? st.quote : null, error: null });
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
    { id: "loop-1", tenantId: "T-1", leadId: "L-1", step: 4, createdAt: new Date("2026-11-01T00:00:00Z"), triggerCondition: "quote expiry" },
  ],
  loadLoopLead: async () => ({
    ok: true,
    lead: {
      id: "L-1", company: "Acme", contactName: "Asha", contactEmail: "asha@acme.test", contactPhone: null,
      seats: 10, plan: "Google Workspace Business Starter", stage: "quoted", isJunk: false, requiresHumanAttention: false,
    },
  }),
  lastCustomerMessageAt: async () => null,
  closeLoop: async () => undefined,
  scheduleSalesLoop: async () => undefined,
}));
vi.mock("@/lib/ai/sales-agent.server", () => ({
  loadSalesCatalog: async () => [],
  /* The model: a held brief makes it hand over (as the real money guard does for a held figure). */
  runSalesAgent: async (a: Record<string, unknown>) => {
    st.agentArgs.push(a);
    const body = a.heldQuote ? "Which state is your business registered in?" : "Your quote of Rs 38,232 expires soon.";
    return {
      ok: true,
      decision: {
        action_required: a.heldQuote ? "HANDOVER_TO_HUMAN" : "REPLY",
        generated_response: { body_text: body, whatsapp_summary: body },
        next_followup_loop: null,
      },
      overruled: false, overruleReason: "", allowedMoney: [],
    };
  },
}));
vi.mock("@/lib/ai/actions/quote-dispatcher", () => ({
  dispatchSalesDecision: async (d: Record<string, unknown>) => { st.dispatched.push(d); return { outcome: "replied", detail: "x", followUp: null }; },
}));
vi.mock("@/lib/quotes/send-auto-quote", () => ({
  autoQuoteHoldFor: async (_admin: unknown, args: unknown) => { st.holdCalls.push(args); return st.hold; },
}));

import { GET } from "./route";

const HELD = {
  status: "held" as const, quoteId: "Q-1", kind: "customer_state" as const,
  reason: "The lead has no state, so the place of supply is unknown.",
  nextStep: "Set the lead's state, then send the quote.",
  href: "/leads?lead=L-1", totals: [32400, 5832, 38232],
};

const cronReq = () => new Request("https://x.invalid/api/cron/ai-sales-loop", { headers: { authorization: "Bearer s3cret" } });

beforeEach(() => {
  st.quote = null; st.agentArgs = []; st.dispatched = []; st.holdCalls = []; st.hold = null; st.quoteOrder = [];
  process.env.CRON_SECRET = "s3cret";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
});

function bodyOf(d: Record<string, unknown>): string {
  const dec = d.decision as { generated_response: { body_text: string; whatsapp_summary: string } };
  return `${dec.generated_response.body_text}\n${dec.generated_response.whatsapp_summary}`;
}

describe("R-2467 — follow-up cron and a HELD draft", () => {
  /* The mocked model hands over when it gets a hold — the real money guard doing that for a held
     figure is proven in R-2460 tests; here the cron must (a) hand the hold over and (b) not brief
     the agent about a quote the customer never received. */
  it("held draft → the hold is passed to the agent; no quote/expiry brief; reply has no amount and goes to a person", async () => {
    st.quote = { id: "Q-1", created_date: "2026-11-01", expires_date: "2026-11-08", status: "draft", payment_status: null };
    st.hold = HELD;
    const res = await GET(cronReq());
    expect(res.status).toBe(200);
    expect(st.holdCalls).toEqual([{ tenantId: "T-1", leadId: "L-1", quoteId: "Q-1" }]);
    expect(st.agentArgs[0].heldQuote).toEqual(HELD);
    const brief = String(st.agentArgs[0].incoming);
    expect(brief).not.toMatch(/This quote|valid until|8 November/);
    expect(brief).toMatch(/on hold and has NOT been sent/);
    const d = st.dispatched[0];
    expect((d.decision as { action_required: string }).action_required).toBe("HANDOVER_TO_HUMAN");
    expect(bodyOf(d)).not.toMatch(/Rs|₹|38,?232|32,?400/);
  });

  it("draft the gate lets through → no hold, follow-up unchanged", async () => {
    st.quote = { id: "Q-1", created_date: "2026-11-01", expires_date: "2026-11-08", status: "draft", payment_status: null };
    st.hold = null;
    await GET(cronReq());
    expect(st.holdCalls).toHaveLength(1);
    expect(st.agentArgs[0].heldQuote ?? null).toBeNull();
    expect(String(st.agentArgs[0].incoming)).toMatch(/This quote (is valid until|expire)/);
    expect((st.dispatched[0].decision as { action_required: string }).action_required).toBe("REPLY");
  });

  it("a SENT quote is not re-checked — it already reached the customer", async () => {
    st.quote = { id: "Q-1", created_date: "2026-11-01", expires_date: "2026-11-08", status: "sent", payment_status: null };
    await GET(cronReq());
    expect(st.holdCalls).toHaveLength(0);
    expect(st.agentArgs[0].heldQuote ?? null).toBeNull();
  });

  it("same-day quotes: newest by the row timestamp, not the text id", async () => {
    st.quote = { id: "Q-1", created_date: "2026-11-01", expires_date: "2026-11-08", status: "sent", payment_status: null };
    await GET(cronReq());
    expect(st.quoteOrder).toEqual(["created_date desc", "created_at desc"]);
  });
});
