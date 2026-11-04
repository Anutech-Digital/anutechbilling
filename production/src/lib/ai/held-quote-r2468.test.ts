import { describe, it, expect, vi, beforeEach } from "vitest";

/* ─────────────────────────────────────────────────────────────────────────────
   R-2468 — the held-quote rule (R-2460 / R-2467) lives inside runSalesAgent itself.

   Before: each CALLER (ingest → runSalesAgentForLead, the follow-up cron) checked the lead's
   newest draft with autoQuoteHoldFor and passed `heldQuote`. A new caller that called
   runSalesAgent directly and forgot would hand the model a held draft's price again.

   Now: no `heldQuote` given → runSalesAgent reads the lead's newest quote itself (newest by
   created_date, same-day ties by created_at) and checks a draft with autoQuoteHoldFor. A
   caller that already checked passes the result (an object, or null = "checked, not held")
   and no second read happens.

   The model is mocked (./gemini): it writes exactly the reply we hand it.
   ───────────────────────────────────────────────────────────────────────────── */

const geminiJson = vi.fn();
const autoQuoteHoldFor = vi.fn();
vi.mock("./gemini", () => ({
  resolveGeminiConfig: async () => ({ apiKey: "test-key", model: "test-model", tenantId: "t-1" }),
  geminiJson: (a: { label?: string }) => geminiJson(a),
}));
vi.mock("@/lib/quotes/send-auto-quote", () => ({
  autoQuoteHoldFor: (...a: unknown[]) => autoQuoteHoldFor(...a),
}));

import { runSalesAgent } from "./sales-agent.server";

const ITEM_ROW = {
  id: "item-starter", name: "Google Workspace Business Starter", vendor: "google",
  msrp: 270, wholesale: 200, prices: null,
};

const st = { quote: null as Record<string, unknown> | null, quoteOrder: [] as string[] };

/** Answers the catalogue read (items, awaited as a list) and the newest-quote read (quotes). */
function fakeAdmin() {
  return {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gt", "in", "limit"]) b[m] = () => b;
      b.order = (c: string, o?: { ascending?: boolean }) => {
        if (table === "quotes") st.quoteOrder.push(`${c} ${o?.ascending === false ? "desc" : "asc"}`);
        return b;
      };
      b.maybeSingle = async () => ({ data: table === "quotes" ? st.quote : null, error: null });
      b.then = (ok: (v: unknown) => unknown) =>
        Promise.resolve({ data: table === "items" ? [ITEM_ROW] : [], error: null }).then(ok);
      return b;
    },
  } as never;
}

/* A direct caller like a new cron would write it: existingQuoteId null, no heldQuote. */
const LEAD = {
  leadId: "lead-1", company: "Acme Traders", contactName: "Asha", seats: 10,
  plan: "Google Workspace Business Starter", customerContact: "asha@acme.test",
  channel: "email" as const, existingQuoteId: null, deliveredQuoteId: null,
  gstin: null,
};
const HELD = {
  status: "held" as const, quoteId: "Q-TEST-2026-27-0001", kind: "customer_state" as const,
  reason: "The lead has no state, so the place of supply is unknown.",
  nextStep: "Set the lead's state, then send the quote.",
  href: "/leads?lead=lead-1", totals: [32400, 5832, 38232],
};
const DRAFT = { id: HELD.quoteId, status: "draft" };

function modelReply(body: string) {
  return {
    customer_intent: "wants a quote for 10 Starter seats",
    perceived_sentiment: "interested",
    confidence_score: 0.95,
    action_required: "REPLY",
    handover_reason: null,
    generated_response: { email_subject: "Your quote", body_text: body, whatsapp_summary: body },
    term_discussed: null,
    next_followup_loop: null,
    seats_discussed: 10,
  };
}
const prompts: string[] = [];
function agentSays(body: string) {
  geminiJson.mockImplementation(async (a: { label?: string; user?: string }) => {
    if (a.label !== "ai/sales-agent") return null;
    prompts.push(String(a.user ?? ""));
    return modelReply(body);
  });
}

const PRICE_REPLY = "Namaste Asha,\n\nFor 10 users the total is ₹38,232 including GST.\n\nRegards";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
  geminiJson.mockReset();
  autoQuoteHoldFor.mockReset();
  st.quote = null; st.quoteOrder = []; prompts.length = 0;
});

const call = (extra: Record<string, unknown> = {}) =>
  runSalesAgent({
    admin: fakeAdmin(), tenantId: "t-1", lead: LEAD, incoming: "price?",
    sellerName: "Seller Pvt Ltd", sellerEmail: "sales@seller.test",
    extraAuthorisedTotals: [32400, 38232],
    ...extra,
  });

describe("R-2468 — runSalesAgent checks the hold itself", () => {
  it("direct call, no heldQuote, newest quote is a HELD draft → the reply naming its amount goes to a person", async () => {
    st.quote = DRAFT;
    autoQuoteHoldFor.mockResolvedValue(HELD);
    agentSays(PRICE_REPLY);
    const r = await call();
    expect(autoQuoteHoldFor).toHaveBeenCalledWith(expect.anything(), { tenantId: "t-1", leadId: "lead-1", quoteId: HELD.quoteId });
    if (!r.ok) throw new Error(r.reason);
    expect(r.decision.action_required).toBe("HANDOVER_TO_HUMAN");
    for (const t of HELD.totals) expect(r.allowedMoney).not.toContain(t);
    expect(prompts[0]).toMatch(/QUOTATION ON HOLD/);
  });

  it("newest quote is read by created_date, same-day ties by created_at (not the text id)", async () => {
    st.quote = DRAFT;
    autoQuoteHoldFor.mockResolvedValue(HELD);
    agentSays(PRICE_REPLY);
    await call();
    expect(st.quoteOrder).toEqual(["created_date desc", "created_at desc"]);
  });

  it("a caller's precomputed hold is used — no second read", async () => {
    st.quote = DRAFT;
    agentSays(PRICE_REPLY);
    const r = await call({ heldQuote: HELD });
    expect(autoQuoteHoldFor).not.toHaveBeenCalled();
    expect(st.quoteOrder).toEqual([]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.decision.action_required).toBe("HANDOVER_TO_HUMAN");
  });

  it("a caller that checked and found no hold (null) → no second read, amount allowed", async () => {
    st.quote = DRAFT;
    agentSays(PRICE_REPLY);
    const r = await call({ heldQuote: null });
    expect(autoQuoteHoldFor).not.toHaveBeenCalled();
    if (!r.ok) throw new Error(r.reason);
    expect(r.decision.action_required).toBe("REPLY");
  });

  it("newest quote already SENT → not re-checked (it reached the customer)", async () => {
    st.quote = { id: HELD.quoteId, status: "sent" };
    agentSays(PRICE_REPLY);
    const r = await call();
    expect(autoQuoteHoldFor).not.toHaveBeenCalled();
    if (!r.ok) throw new Error(r.reason);
    expect(r.decision.action_required).toBe("REPLY");
  });

  it("no quote on the lead → nothing to check", async () => {
    agentSays("Namaste Asha, Starter is ₹3,240 per seat per year.");
    const r = await call({ extraAuthorisedTotals: [] });
    expect(autoQuoteHoldFor).not.toHaveBeenCalled();
    if (!r.ok) throw new Error(r.reason);
    expect(r.decision.action_required).toBe("REPLY");
  });
});
