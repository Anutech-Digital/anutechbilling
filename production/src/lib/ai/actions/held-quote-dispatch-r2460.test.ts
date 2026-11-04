import { describe, it, expect, vi, beforeEach } from "vitest";

/* ─────────────────────────────────────────────────────────────────────────────
   R-2460 — the agent's OWN quote path (GENERATE_QUOTE_AND_SEND).

   The agent writes its reply first (with seats × list and the net cost authorised — no quote
   exists yet), then the dispatcher drafts the quote and sendAutoQuote HOLDS it (no state /
   needs approval). Before R-2460 the reply then went out as written — "your total is
   ₹38,232" — the very price the gate had refused to send. Now a reply that names a held
   figure is handed to a person instead; a reply that does not still goes out.
   ───────────────────────────────────────────────────────────────────────────── */

const sendCustomerEmail = vi.fn();
const autoQuoteForLead = vi.fn();
const flagLeadForHumanAttention = vi.fn();

vi.mock("@/lib/messaging", () => ({
  sendCustomerEmail: (...a: unknown[]) => sendCustomerEmail(...a),
  sendCustomerWhatsApp: vi.fn(),
}));
vi.mock("@/lib/quotes/auto-quote-for-lead", async (orig) => ({
  ...(await orig<typeof import("@/lib/quotes/auto-quote-for-lead")>()),
  autoQuoteForLead: (...a: unknown[]) => autoQuoteForLead(...a),
}));
vi.mock("@/lib/quotes/quote-pdf-attachment", () => ({
  quotePdfAttachment: async () => null,
  mentionsQuote: () => false,
}));
vi.mock("../sales-agent.server", () => ({
  recordSalesTurn: async () => true,
  flagLeadForHumanAttention: (...a: unknown[]) => flagLeadForHumanAttention(...a),
}));
vi.mock("../autonomy.server", () => ({
  loadAutonomyPolicy: async () => ({ killSwitch: false, modes: {} }),
  logAiAction: async () => undefined,
}));

import { dispatchSalesDecision } from "./quote-dispatcher";

const HELD = {
  status: "held" as const, quoteId: "Q-TEST-2026-27-0001", kind: "customer_state" as const,
  reason: "The lead has no state, so the place of supply is unknown.",
  nextStep: "Set the lead's state, then send the quote.",
  href: "/leads?lead=lead-1", totals: [32400, 5832, 38232],
};

function fakeAdmin() {
  const notes: string[] = [];
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) b[m] = () => b;
  b.insert = (v: { detail?: string }) => { if (v?.detail) notes.push(v.detail); return Promise.resolve({ data: null, error: null }); };
  return { admin: { from: () => b } as never, notes };
}

function args(body: string, admin: never) {
  return {
    admin, tenantId: "t-1", leadId: "lead-1", company: "Acme Traders",
    customerContact: "asha@acme.test", channel: "email" as const,
    decision: {
      customer_intent: "wants 10 Starter seats", perceived_sentiment: "interested",
      confidence_score: 0.95, action_required: "GENERATE_QUOTE_AND_SEND" as const,
      handover_reason: null,
      generated_response: { email_subject: "Your quote", body_text: body, whatsapp_summary: body },
      term_discussed: null, next_followup_loop: null, seats_discussed: 10,
    },
    sendAction: "reply.send" as const, overruled: false, overruleReason: "",
    incomingSubject: "quote please", seats: 10,
    catalogue: [{ id: "item-starter", name: "Google Workspace Business Starter", msrp: 270, wholesale: 200, prices: null }],
    leadPlan: "Google Workspace Business Starter", deliveredQuoteId: null,
    term: null, termSource: null, fromEmail: "sales@seller.test",
    senderIsOurs: false, isSelfTest: false,
  } as never;
}

beforeEach(() => {
  sendCustomerEmail.mockReset().mockResolvedValue({ status: "sent" });
  flagLeadForHumanAttention.mockReset().mockResolvedValue({ ok: true });
  autoQuoteForLead.mockReset().mockResolvedValue({
    emailed: false, reason: `Quote held — ${HELD.reason} ${HELD.nextStep}`, held: HELD,
  });
});

describe("R-2460 — dispatcher: a held quote's figure never rides out on the covering reply", () => {
  it("reply names the held gross → NOT emailed; handed to a person with 'Quote held'", async () => {
    const { admin, notes } = fakeAdmin();
    const r = await dispatchSalesDecision(args("Namaste Asha, the total is ₹38,232 including GST.", admin));
    for (const call of sendCustomerEmail.mock.calls) {
      expect(String((call[0] as { text?: string }).text)).not.toContain("38,232");
    }
    expect(sendCustomerEmail).not.toHaveBeenCalled();
    expect(r.outcome).toBe("handed_over");
    expect(r.detail).toMatch(/Quote held/);
    expect(notes.some((n) => /Quote held/.test(n))).toBe(true);
  });

  it("any amount worked out for the held quotation (list total, discount saved) → not emailed", async () => {
    for (const body of [
      "Namaste Asha, 10 users at list come to ₹32,000 + GST.",
      "Namaste Asha, you save Rs 1,600 with the volume rate.",
    ]) {
      sendCustomerEmail.mockClear();
      const { admin } = fakeAdmin();
      const r = await dispatchSalesDecision(args(body, admin));
      expect(sendCustomerEmail, body).not.toHaveBeenCalled();
      expect(r.outcome, body).toBe("handed_over");
    }
  });

  it("the held gross written as a bare number (no ₹) is caught too", async () => {
    const { admin } = fakeAdmin();
    const r = await dispatchSalesDecision(args("Namaste Asha, the total is 38,232 including GST.", admin));
    expect(sendCustomerEmail).not.toHaveBeenCalled();
    expect(r.outcome).toBe("handed_over");
  });

  it("a reply with no amount still goes out — and asks for the missing state", async () => {
    const { admin } = fakeAdmin();
    await dispatchSalesDecision(args("Namaste Asha, thanks — your quotation will follow.", admin));
    expect(sendCustomerEmail).toHaveBeenCalledTimes(1);
    const text = String((sendCustomerEmail.mock.calls[0][0] as { text: string }).text);
    expect(text).toMatch(/which state is your business registered in/);
    expect(text).not.toContain("38,232");
  });

  it("held for approval: no state question (that is ours to sort out)", async () => {
    autoQuoteForLead.mockResolvedValue({
      emailed: false, reason: "Quote held — needs approval.", held: { ...HELD, kind: "approval" },
    });
    const { admin } = fakeAdmin();
    await dispatchSalesDecision(args("Namaste Asha, thanks — your quotation will follow.", admin));
    expect(sendCustomerEmail).toHaveBeenCalledTimes(1);
    expect(String((sendCustomerEmail.mock.calls[0][0] as { text: string }).text)).not.toMatch(/which state/);
  });
});
