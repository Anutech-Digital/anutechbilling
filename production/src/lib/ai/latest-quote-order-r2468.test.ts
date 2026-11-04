import { describe, it, expect, vi } from "vitest";

/* R-2468 — runSalesAgentForLead's newest-quote read breaks same-day ties by the row's own
   timestamp (created_at), like the follow-up cron (R-2467) — not by the text id, which sorts
   wrong when the prefix changes or the number passes 9999. */

const runSalesAgent = vi.fn();
const quoteOrder: string[] = [];

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
vi.mock("@/lib/quotes/send-auto-quote", () => ({ autoQuoteHoldFor: async () => null }));

import { runSalesAgentForLead } from "./run-sales-agent";

function fakeAdmin() {
  return {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "limit"]) b[m] = () => b;
      b.order = (c: string, o?: { ascending?: boolean }) => {
        if (table === "quotes") quoteOrder.push(`${c} ${o?.ascending === false ? "desc" : "asc"}`);
        return b;
      };
      b.insert = async () => ({ data: null, error: null });
      b.maybeSingle = async () => ({
        data: table === "leads" ? { company: "Acme", seats: 10, plan: "Google Workspace Business Starter" }
          : table === "quotes" ? { id: "Q-1", status: "sent", subtotal: 100, amount: 118 } : null,
        error: null,
      });
      return b;
    },
  } as never;
}

describe("R-2468 — newest quote by created_at", () => {
  it("orders created_date desc, then created_at desc", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test");
    runSalesAgent.mockResolvedValue({ ok: false, reason: "stop here" });
    await runSalesAgentForLead({
      admin: fakeAdmin(), tenantId: "t-1", leadId: "lead-1", incoming: "price?",
      customerContact: "asha@acme.test", channel: "email", senderIsOurs: false, isSelfTest: false,
      fromEmail: "sales@seller.test", sellerName: "Seller Pvt Ltd",
    });
    expect(quoteOrder).toEqual(["created_date desc", "created_at desc"]);
  });
});
