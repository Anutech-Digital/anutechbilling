/**
 * R-2165 (G-ADS-AI, AI-09) — POST /api/marketing/neo/ask.
 * The DB is a fake behind withTenant; the query records what it was handed (the real
 * function is proven in supabase/tests/r2165_marketing_metrics_query.test.sql).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  session: null as { userId: string; tenantId: string; aal: string } | null,
  role: "owner" as string | null,
  active: true,
  aiKey: "test-key" as string | null,
  aiCalls: [] as Array<{ tenantId: string | null; label: string }>,
  aiReply: null as unknown,
  aiCap: null as string | null,
  queries: [] as unknown[][],
  dbError: null as Error | null,
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/ai/gemini", () => ({
  resolveGeminiConfig: async () => ({ apiKey: h.aiKey, model: "test-model" }),
  geminiJson: async (args: { tenantId: string | null; label: string; onCapReached?: (m: string) => void }) => {
    h.aiCalls.push({ tenantId: args.tenantId, label: args.label });
    if (h.aiCap) { args.onCapReached?.(h.aiCap); return null; }
    return h.aiReply;
  },
}));
vi.mock("@/server/auth/session", () => ({ getTenantSession: async () => h.session }));
vi.mock("@/server/db", () => ({
  withTenant: async (_s: unknown, fn: (tx: unknown) => unknown) => fn({
    public_users: { findUnique: async () => (h.role ? { role: h.role, is_active: h.active } : null) },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (h.dbError) throw h.dbError;
      h.queries.push(values);
      const [metrics, dimensions, from, to] = values as [string[], string[], string, string];
      return [{ r: {
        metrics, dimensions, from, to, revenue_visible: true,
        rows: [{ day: from, spend: 100, revenue: 500, roas: 5 }],
        total: { spend: 100, revenue: 500, roas: 5 }, row_count: 1, truncated: false,
      } }];
    },
  }),
}));

import { POST } from "./ask/route";

const ask = (body: unknown) => POST(new Request("https://example.invalid/api/marketing/neo/ask", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));

beforeEach(() => {
  h.session = { userId: "aaaaaaaa-0000-4000-8000-000000000001", tenantId: "11111111-1111-4111-8111-111111111111", aal: "aal1" };
  h.role = "marketing"; h.active = true; h.aiKey = "test-key"; h.aiCalls = []; h.aiReply = null; h.aiCap = null;
  h.queries = []; h.dbError = null;
});

describe("POST /api/marketing/neo/ask", () => {
  it("401 without a session", async () => {
    h.session = null;
    expect((await ask({ question: "last 7 days ROAS" })).status).toBe(401);
  });

  it.each(["manager", "sales", "accountant"])("403 for %s — Neo is for owner and marketing", async (role) => {
    h.role = role;
    const res = await ask({ question: "last 7 days ROAS" });
    expect(res.status).toBe(403);
    expect(h.queries).toHaveLength(0);
  });

  it("403 for a deactivated owner", async () => {
    h.role = "owner"; h.active = false;
    expect((await ask({ question: "last 7 days ROAS" })).status).toBe(403);
  });

  it("400 for an empty / too long / extra-field body", async () => {
    expect((await ask({ question: "" })).status).toBe(400);
    expect((await ask({ question: "x".repeat(501) })).status).toBe(400);
    expect((await ask({ question: "roas", sql: "select 1" })).status).toBe(400);
  });

  it("200: the plan's values go to the function as bound parameters, the reply carries summary + chart", async () => {
    const res = await ask({ question: "last 7 days ROAS" });
    expect(res.status).toBe(200);
    const { reply } = await res.json();
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0].slice(0, 2)).toEqual([["roas", "revenue", "spend"], ["day"]]);
    expect(reply.planSource).toBe("rules");
    expect(reply.answer.summary).toMatch(/^Last 7 days .*: ROAS 5\.00× · Revenue ₹500 · Spend ₹100\.$/);
    expect(reply.answer.chart.type).toBe("line");
    expect(h.aiCalls).toHaveLength(0);
  });

  it("an unclear question asks the AI under this company's cap; a used-up cap is 429", async () => {
    h.aiCap = "This month's AI limit is used up.";
    const res = await ask({ question: "how are we doing?" });
    expect(res.status).toBe(429);
    expect(h.aiCalls).toEqual([{ tenantId: "11111111-1111-4111-8111-111111111111", label: "marketing/neo-ask" }]);
    expect(h.queries).toHaveLength(0);
  });

  it("the database's own refusal reads as 403 / 400, not 500", async () => {
    h.dbError = new Error('ERROR: marketing_metrics_query: only the owner and the marketing team can ask about marketing numbers (42501)');
    expect((await ask({ question: "spend last 7 days" })).status).toBe(403);
    h.dbError = new Error('ERROR: marketing_metrics_query: unknown metric "x"');
    const res = await ask({ question: "spend last 7 days" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/unknown metric/);
  });
});
