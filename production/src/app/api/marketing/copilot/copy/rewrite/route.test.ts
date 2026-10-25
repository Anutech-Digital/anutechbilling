/**
 * R-1897 — POST /api/marketing/copilot/copy/rewrite ("Rewrite this line"). The AI is MOCKED
 * (geminiJson); no real AI call. Only the one line comes back, inside the same limit; a too-long,
 * repeated or new-price answer is refused with the reason, never returned as valid.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  session: { userId: "u1", tenantId: "t1", aal: "aal1" } as { userId: string; tenantId: string; aal: string } | null,
  role: "marketing" as string | null,
  plan: { tone: "friendly", language: "en", objective: "lead_gen", platforms: ["google-ads", "meta-ads"], item_id: "i1", prompt: "Diwali offer for Delhi SMEs" } as Record<string, unknown> | null,
  apiKey: "sk-ant-test-key-1234567890" as string | null,
  gemini: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({ getTenantSession: async () => h.session }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({}) }));
vi.mock("@/server/db", () => ({
  withTenant: async (_s: unknown, fn: (tx: unknown) => unknown) => fn({
    public_users: { findUnique: async () => (h.role ? { role: h.role, is_active: true } : null) },
    tenants: { findUnique: async () => ({ name: "Anutech Digital" }) },
    ad_plans: { findFirst: async () => h.plan },
    items: { findFirst: async () => ({ name: "Google Workspace" }) },
  }),
}));
vi.mock("@/lib/ai/gemini", () => ({
  resolveGeminiConfig: async (_c: unknown, tenantId: string) => ({ apiKey: h.apiKey, model: "claude-test", tenantId }),
  geminiJson: h.gemini,
}));

import { POST } from "./route";

const PLAN = "6f1c2a52-6b8e-4b7a-9a59-0f5e8f3f0a11";
const call = (body: Record<string, unknown>) => POST(new Request("https://example.invalid/api/marketing/copilot/copy/rewrite", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));
const ASK = {
  planId: PLAN, platform: "google-ads", field: "headline", current: "Workspace headline 4",
  others: ["Workspace headline 1", "Workspace headline 2", "Workspace headline 3"], audience: "generic",
};

beforeEach(() => {
  h.session = { userId: "u1", tenantId: "t1", aal: "aal1" };
  h.role = "marketing";
  h.apiKey = "sk-ant-test-key-1234567890";
  h.gemini.mockReset();
});

describe("Rewrite this line", () => {
  it("returns ONE new line inside the 30-character limit, counted against this company's AI cap", async () => {
    h.gemini.mockResolvedValueOnce({ text: "Email your team will love" });
    const r = await call(ASK);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ text: "Email your team will love", length: 25, limit: 30 });
    const [args] = h.gemini.mock.calls[0];
    expect(args.tenantId).toBe("t1");
    expect(args.user).toContain("Old line: Workspace headline 4");
    expect(args.user).toContain("Workspace headline 1");
    expect(args.user).toContain("at most 30 characters");
  });

  it("an answer over the hard limit is refused, not returned", async () => {
    h.gemini.mockResolvedValueOnce({ text: "This headline is far too long for Google Ads" });
    const r = await call(ASK);
    expect(r.status).toBe(422);
    expect((await r.json()).error).toMatch(/longer than 30/);
  });

  it("an answer that repeats another line is refused", async () => {
    h.gemini.mockResolvedValueOnce({ text: "workspace headline 2" });
    expect((await call(ASK)).status).toBe(422);
  });

  it("a ₹ price nobody gave is refused (money guard)", async () => {
    h.gemini.mockResolvedValueOnce({ text: "Workspace at ₹99 only" });
    const r = await call(ASK);
    expect(r.status).toBe(422);
    expect((await r.json()).error).toMatch(/price/);
  });

  it("no AI key → 503 with a plain reason; no AI call", async () => {
    h.apiKey = null;
    const r = await call(ASK);
    expect(r.status).toBe(503);
    expect(h.gemini).not.toHaveBeenCalled();
  });

  it("cap reached → 429", async () => {
    h.gemini.mockImplementationOnce(async (a: { onCapReached?: (m: string) => void }) => { a.onCapReached?.("Monthly AI limit reached."); return null; });
    expect((await call(ASK)).status).toBe(429);
  });

  it("401 / 403 / unknown field / CTA field → no AI call", async () => {
    h.session = null;
    expect((await call(ASK)).status).toBe(401);
    h.session = { userId: "u1", tenantId: "t1", aal: "aal1" };
    h.role = "sales";
    expect((await call(ASK)).status).toBe(403);
    h.role = "owner";
    expect((await call({ ...ASK, field: "nope" })).status).toBe(400);
    expect((await call({ ...ASK, platform: "meta-ads", field: "cta", current: "GET_QUOTE" })).status).toBe(400);
    expect(h.gemini).not.toHaveBeenCalled();
  });

  it("another company's plan → 404", async () => {
    h.plan = null;
    expect((await call(ASK)).status).toBe(404);
    h.plan = { tone: "friendly", language: "en", objective: "lead_gen", platforms: ["google-ads", "meta-ads"], item_id: "i1", prompt: "Diwali offer for Delhi SMEs" };
  });
});
