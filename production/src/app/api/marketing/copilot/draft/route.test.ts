/**
 * R-1879 — POST /api/marketing/copilot/draft: one sentence → a SAVED draft plan.
 * The AI is MOCKED (geminiJson); the DB is an in-memory fake behind withTenant.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  session: { userId: "u1", tenantId: "t1", aal: "aal1" } as { userId: string; tenantId: string; aal: string } | null,
  role: "marketing" as string | null,
  apiKey: "sk-ant-test-key-1234567890" as string | null,
  gemini: vi.fn(),
  plans: [] as Row[],
  groups: [] as Row[],
}));

vi.mock("@/server/auth/session", () => ({ getTenantSession: async () => h.session }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({}) }));
vi.mock("@/server/db", () => ({
  withTenant: async (_s: unknown, fn: (tx: unknown) => unknown) => fn({
    public_users: { findUnique: async () => (h.role ? { role: h.role, is_active: true } : null) },
    items: {
      findMany: async () => [
        { id: "i-gws", name: "Google Workspace Business Starter" },
        { id: "i-tally", name: "Tally Prime" },
      ],
    },
    ad_plans: {
      create: async ({ data }: { data: Row }) => { const r = { id: `p${h.plans.length + 1}`, ...data }; h.plans.push(r); return { id: r.id }; },
    },
    ad_target_groups: { createMany: async ({ data }: { data: Row[] }) => { h.groups.push(...data); return { count: data.length }; } },
  }),
}));
vi.mock("@/lib/ai/gemini", () => ({
  resolveGeminiConfig: async () => ({ apiKey: h.apiKey, model: "claude-test" }),
  geminiJson: h.gemini,
}));

import { POST } from "./route";

const call = (body: unknown) =>
  POST(new Request("https://example.invalid/api/marketing/copilot/draft", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));

const PROMPT = "Diwali offer on Google Workspace for Delhi SMEs — get enquiries";

beforeEach(() => {
  h.session = { userId: "u1", tenantId: "t1", aal: "aal1" };
  h.role = "marketing";
  h.apiKey = "sk-ant-test-key-1234567890";
  h.gemini.mockReset();
  h.plans = [];
  h.groups = [];
});

describe("POST /api/marketing/copilot/draft — who", () => {
  it("401 without a company session; nothing saved, no AI", async () => {
    h.session = null;
    expect((await call({ prompt: PROMPT })).status).toBe(401);
    expect(h.gemini).not.toHaveBeenCalled();
    expect(h.plans).toHaveLength(0);
  });

  it("403 for sales", async () => {
    h.role = "sales";
    expect((await call({ prompt: PROMPT })).status).toBe(403);
    expect(h.gemini).not.toHaveBeenCalled();
  });

  it("400 for an empty prompt", async () => {
    expect((await call({ prompt: "  " })).status).toBe(400);
  });
});

describe("POST /api/marketing/copilot/draft — what", () => {
  it("AI answer → checked fields saved as a draft with its audience", async () => {
    h.gemini.mockResolvedValue({
      name: "Diwali Workspace — Delhi", itemId: "i-gws", objective: "lead_gen", platforms: ["google-ads", "meta-ads"],
      ageMin: 25, ageMax: 55, genders: [], regions: ["Delhi", "Atlantis"],
    });
    const res = await call({ prompt: PROMPT });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ planId: "p1", mode: "ai" });
    expect(h.plans[0]).toMatchObject({
      tenant_id: "t1", status: "draft", name: "Diwali Workspace — Delhi", item_id: "i-gws",
      objective: "lead_gen", platforms: ["google-ads", "meta-ads"], prompt: PROMPT, language: "en",
    });
    expect(h.groups).toEqual([expect.objectContaining({ tenant_id: "t1", plan_id: "p1", kind: "generic", platform: null, age_min: 25, age_max: 55, regions: ["Delhi"] })]);
    expect(h.gemini.mock.calls[0][0]).toMatchObject({ tenantId: "t1", label: "marketing/copilot-draft" });
  });

  it("no AI key → plain guess, still saved (mode stub)", async () => {
    h.apiKey = null;
    const body = await (await call({ prompt: PROMPT })).json();
    expect(body.mode).toBe("stub");
    expect(h.gemini).not.toHaveBeenCalled();
    expect(h.plans[0]).toMatchObject({ item_id: "i-gws", objective: "lead_gen" });
    expect(h.groups[0]).toMatchObject({ regions: ["Delhi"] });
  });

  it("AI fails → guess, with a note", async () => {
    h.gemini.mockResolvedValue(null);
    const body = await (await call({ prompt: PROMPT })).json();
    expect(body.mode).toBe("stub");
    expect(body.note).toMatch(/AI/);
    expect(h.plans).toHaveLength(1);
  });

  it("AI cap used up → 429, nothing saved", async () => {
    h.gemini.mockImplementation(async (a: { onCapReached?: (m: string) => void }) => { a.onCapReached?.("This month's AI limit is used up."); return null; });
    const res = await call({ prompt: PROMPT });
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("ai_cap_reached");
    expect(h.plans).toHaveLength(0);
  });
});
