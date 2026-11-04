import { describe, it, expect, vi, beforeEach } from "vitest";

/* ─────────────────────────────────────────────────────────────────────────────
   R-2460 — the AI sales agent never states a HELD quote's figures.

   Owner's path: an enquiry from a lead with no state → the app drafts 10 × Business Starter
   (₹32,400 + GST = ₹38,232) → the customer-copy gate HOLDS it (no place of supply) → the agent
   answers the customer. Before R-2460 the agent was handed ₹32,400 / ₹38,232 as authorised
   totals (the draft's own figures, seats × list, and the net-cost block), so a reply saying
   "your total is ₹38,232" passed the money guard and reached the customer — a price nobody had
   approved, on a GST quote with no place of supply.

   The model is mocked (./gemini): it writes exactly the reply we hand it. The guard, not the
   model's good manners, is what must stop the figure.
   ───────────────────────────────────────────────────────────────────────────── */

const geminiJson = vi.fn();
vi.mock("./gemini", () => ({
  resolveGeminiConfig: async () => ({ apiKey: "test-key", model: "test-model", tenantId: "t-1" }),
  geminiJson: (a: { label?: string }) => geminiJson(a),
}));

import { runSalesAgent } from "./sales-agent.server";
import { buildSalesAgentPrompt, type SalesCatalogEntry } from "./sales-agent";
import { verifyDraftMoney } from "./money-guard";

const ITEM_ROW = {
  id: "item-starter", name: "Google Workspace Business Starter", vendor: "google",
  msrp: 270, wholesale: 200, prices: null,
};
/** A supabase-js stand-in that only needs to answer the catalogue read. */
function fakeAdmin() {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gt", "in", "order", "limit"]) b[m] = () => b;
  b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [ITEM_ROW], error: null }).then(ok);
  return { from: () => b } as never;
}

const LEAD = {
  leadId: "lead-1", company: "Acme Traders", contactName: "Asha", seats: 10,
  plan: "Google Workspace Business Starter", customerContact: "asha@acme.test",
  channel: "email" as const, existingQuoteId: "Q-TEST-2026-27-0001", deliveredQuoteId: null,
  gstin: null,
};
/** The held draft: 10 × ₹3,240 = ₹32,400 + 18% GST ₹5,832 = ₹38,232. */
const HELD = {
  status: "held" as const, quoteId: "Q-TEST-2026-27-0001", kind: "customer_state" as const,
  reason: "The lead has no state, so the place of supply is unknown.",
  nextStep: "Set the lead's state, then send the quote.",
  href: "/leads?lead=lead-1", totals: [32400, 5832, 38232],
};

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

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
  geminiJson.mockReset();
});

function agentSays(body: string) {
  geminiJson.mockImplementation(async (a: { label?: string }) =>
    a.label === "ai/sales-agent" ? modelReply(body) : null);
}

const run = (heldQuote: typeof HELD | null) =>
  runSalesAgent({
    admin: fakeAdmin(), tenantId: "t-1", lead: LEAD, incoming: "10 Starter users ka quote bhejo",
    sellerName: "Seller Pvt Ltd", sellerEmail: "sales@seller.test",
    extraAuthorisedTotals: [32400, 38232], heldQuote,
  });

describe("R-2460 — a held quote's total never goes out in the agent's reply", () => {
  it("control: with no hold, the same reply naming ₹38,232 is allowed (the draft's own figure)", async () => {
    agentSays("Namaste Asha,\n\nFor 10 users the total is ₹38,232 including GST.\n\nRegards");
    const r = await run(null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.decision.action_required).toBe("REPLY");
  });

  it("held: a reply naming the held gross (₹38,232) is stopped — handed to a person, not sent", async () => {
    agentSays("Namaste Asha,\n\nFor 10 users the total is ₹38,232 including GST.\n\nRegards");
    const r = await run(HELD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.decision.action_required).toBe("HANDOVER_TO_HUMAN");
    expect(r.allowedMoney).not.toContain(38232);
    expect(r.allowedMoney).not.toContain(32400);
  });

  it("held: the subtotal (₹32,400 + GST) is stopped too", async () => {
    agentSays("Namaste Asha,\n\n10 users come to Rs 32,400 plus GST.\n\nRegards");
    const r = await run(HELD);
    if (!r.ok) throw new Error(r.reason);
    expect(r.decision.action_required).toBe("HANDOVER_TO_HUMAN");
  });

  it("held: a reply that asks for the state and says the quote will follow still goes out", async () => {
    agentSays(
      "Namaste Asha,\n\nThanks! Which state is your business registered in? GST on the quotation " +
      "depends on it — your quotation will follow as soon as we have it. Starter is ₹3,240 per seat per year.\n\nRegards",
    );
    const r = await run(HELD);
    if (!r.ok) throw new Error(r.reason);
    expect(r.decision.action_required).toBe("REPLY");
    // And nothing in what goes out is a held figure.
    const found = verifyDraftMoney(r.decision.generated_response.body_text, []).found;
    for (const t of HELD.totals) expect(found).not.toContain(t);
  });
});

describe("R-2460 — the prompt itself: no held total, and what to say instead", () => {
  const CATALOGUE: SalesCatalogEntry[] = [{
    sku: "item-starter", name: "Google Workspace Business Starter", vendor: "google",
    msrpPerSeatPerYear: 3240, wholesalePerSeatPerYear: 2400, monthlyFlexPerSeatPerMonth: null,
  }];
  const build = (heldQuote: typeof HELD | null) => buildSalesAgentPrompt({
    lead: LEAD, history: [], incoming: "quote please", catalog: CATALOGUE,
    sellerName: "Seller Pvt Ltd", sellerEmail: "sales@seller.test",
    authorisedTotals: [32400, 38232], heldQuote,
  });

  it("held (no state): asks the model for the state, states no total, authorises no held figure", () => {
    const p = build(HELD);
    expect(p.user).toMatch(/QUOTATION ON HOLD/);
    expect(p.user).toMatch(/which state/i);
    expect(p.user).toMatch(/will follow/i);
    expect(p.user).not.toContain("38,232");
    expect(p.user).not.toContain("32,400");
    expect(p.authorisedTotals).toEqual([]);
    for (const t of HELD.totals) expect(p.allowedMoney).not.toContain(t);
    // The per-seat list price is public and stays allowed.
    expect(p.allowedMoney).toContain(3240);
  });

  it("held for approval: says the quotation will follow, does not ask the customer for a state", () => {
    const p = build({ ...HELD, kind: "approval" as never });
    expect(p.user).toMatch(/QUOTATION ON HOLD/);
    expect(p.user).toMatch(/will follow/i);
    expect(p.user).not.toMatch(/which state/i);
  });

  it("not held: the prompt is unchanged — totals still authorised", () => {
    const p = build(null);
    expect(p.user).not.toMatch(/QUOTATION ON HOLD/);
    expect(p.allowedMoney).toContain(38232);
  });
});
