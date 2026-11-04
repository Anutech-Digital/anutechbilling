import { describe, it, expect, vi, beforeEach } from "vitest";

/* ─────────────────────────────────────────────────────────────────────────────
   R-2460 — runSalesAgentForLead hands the hold to the agent.

   Two ways a held draft reaches the agent:
     1. ingest.ts just tried to send it and got "held" → passes `heldQuote` explicitly;
     2. a LATER message on the same lead (no new quote, the draft still held) → the agent's
        own "latest quote" read must notice the hold itself, or the draft's totals are
        authorised again and the leak is back one message later.
   ───────────────────────────────────────────────────────────────────────────── */

const runSalesAgent = vi.fn();
const autoQuoteHoldFor = vi.fn();

vi.mock("@/lib/supabase/bare", () => ({ createBareClient: () => ({}) }));
vi.mock("./sales-agent.server", () => ({
  runSalesAgent: (...a: unknown[]) => runSalesAgent(...a),
  recordSalesTurn: async () => true,
}));
vi.mock("./sales-loops.server", () => ({
  cancelPendingLoops: async () => undefined,
  scheduleSalesLoop: async () => undefined,
}));
vi.mock("./autonomy.server", () => ({ logAiAction: async () => undefined }));
vi.mock("./actions/quote-dispatcher", () => ({ dispatchSalesDecision: async () => ({ followUp: null }) }));
vi.mock("@/lib/quotes/send-auto-quote", () => ({
  autoQuoteHoldFor: (...a: unknown[]) => autoQuoteHoldFor(...a),
}));

import { runSalesAgentForLead } from "./run-sales-agent";

const HELD = {
  status: "held" as const, quoteId: "Q-TEST-2026-27-0001", kind: "customer_state" as const,
  reason: "The lead has no state, so the place of supply is unknown.",
  nextStep: "Set the lead's state, then send the quote.",
  href: "/leads?lead=lead-1", totals: [32400, 5832, 38232],
};

function fakeAdmin(quote: Record<string, unknown> | null) {
  return {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit"]) b[m] = () => b;
      b.insert = async () => ({ data: null, error: null });
      b.maybeSingle = async () => ({
        data: table === "leads" ? { company: "Acme", seats: 10, plan: "Google Workspace Business Starter" }
          : table === "quotes" ? quote : null,
        error: null,
      });
      return b;
    },
  } as never;
}

const base = {
  tenantId: "t-1", leadId: "lead-1", incoming: "price?", customerContact: "asha@acme.test",
  channel: "email" as const, senderIsOurs: false, isSelfTest: false,
  fromEmail: "sales@seller.test", sellerName: "Seller Pvt Ltd",
};

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test");
  runSalesAgent.mockReset().mockResolvedValue({ ok: false, reason: "stop here" });
  autoQuoteHoldFor.mockReset();
});

describe("R-2460 — the agent is told about a held draft", () => {
  it("explicit hold from ingest → heldQuote passed, the draft's totals NOT authorised", async () => {
    await runSalesAgentForLead({
      ...base, admin: fakeAdmin({ id: HELD.quoteId, status: "draft", subtotal: 32400, amount: 38232 }),
      heldQuote: HELD,
    });
    const a = runSalesAgent.mock.calls[0][0] as { heldQuote: unknown; extraAuthorisedTotals: number[] };
    expect(a.heldQuote).toEqual(HELD);
    expect(a.extraAuthorisedTotals).toEqual([]);
  });

  it("a later message, draft still held → the agent's own read finds the hold", async () => {
    autoQuoteHoldFor.mockResolvedValue(HELD);
    await runSalesAgentForLead({
      ...base, admin: fakeAdmin({ id: HELD.quoteId, status: "draft", subtotal: 32400, amount: 38232 }),
    });
    expect(autoQuoteHoldFor).toHaveBeenCalledWith(expect.anything(), { tenantId: "t-1", leadId: "lead-1", quoteId: HELD.quoteId });
    const a = runSalesAgent.mock.calls[0][0] as { heldQuote: unknown; extraAuthorisedTotals: number[] };
    expect(a.heldQuote).toEqual(HELD);
    expect(a.extraAuthorisedTotals).toEqual([]);
  });

  it("a draft the gate would let through keeps its totals (unchanged behaviour)", async () => {
    autoQuoteHoldFor.mockResolvedValue(null);
    await runSalesAgentForLead({
      ...base, admin: fakeAdmin({ id: HELD.quoteId, status: "draft", subtotal: 32400, amount: 38232 }),
    });
    const a = runSalesAgent.mock.calls[0][0] as { heldQuote: unknown; extraAuthorisedTotals: number[] };
    expect(a.heldQuote ?? null).toBeNull();
    expect(a.extraAuthorisedTotals).toEqual([32400, 38232]);
  });

  it("a SENT quote is not re-checked — it already reached the customer", async () => {
    await runSalesAgentForLead({
      ...base, admin: fakeAdmin({ id: HELD.quoteId, status: "sent", subtotal: 32400, amount: 38232 }),
    });
    expect(autoQuoteHoldFor).not.toHaveBeenCalled();
  });
});
