/**
 * R-1877 done-when: "Cap 2 rakh kar teesri call 429 deti hai". The campaign AI writer (the
 * co-pilot's first AI screen) on the server's Claude key: with a monthly cap of 2, calls 1 and 2
 * are written by the AI, call 3 is refused with 429 and the cap message — and Claude is NOT asked
 * a third time. The counter is a fake of the SQL ai_usage_reserve (cap 2); the Anthropic SDK is
 * mocked, so no real AI call is made.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({ createMock: vi.fn(), used: 0, cap: 2 }));

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  class FakeAnthropic extends real.default {
    constructor(opts: ConstructorParameters<typeof real.default>[0]) {
      super(opts);
      (this as unknown as { messages: unknown }).messages = { create: h.createMock };
    }
  }
  return { ...real, default: FakeAnthropic };
});

vi.mock("@/lib/ai/usage-cap", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ai/usage-cap")>();
  return {
    ...real,
    /* Same rule as SQL ai_usage_reserve: used >= cap and enforce → refused, nothing counted. */
    reserveAiCall: vi.fn(async (_t: string, _f: string, enforce: boolean) => {
      const month = "2026-10-01";
      if (enforce && h.used >= h.cap) {
        const s = { used: h.used, cap: h.cap, month };
        return { allowed: false, message: real.aiCapMessage(s), ...s };
      }
      h.used += 1;
      return { allowed: true, used: h.used, cap: h.cap, month };
    }),
    recordAiTokens: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            table === "users" ? { data: { tenant_id: "t1", role: "owner" } } : { data: null },
        }),
      }),
    }),
  }),
}));

import { POST } from "./route";

const CLAUDE_KEY = "sk-ant-test-" + "c".repeat(20);
const call = () =>
  POST(new Request("https://example.invalid/api/campaigns/ai-generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Diwali offer for Google Workspace", category: "offer" }),
  }));

beforeEach(() => {
  h.used = 0;
  h.createMock.mockReset();
  h.createMock.mockResolvedValue({
    content: [{ type: "text", text: '{"name":"Diwali","subject":"Diwali offer","body_html":"<p>Hi</p>","body_text":"Hi"}' }],
    stop_reason: "end_turn",
    usage: { input_tokens: 500, output_tokens: 120 },
  });
  vi.stubEnv("AI_PROVIDER", "claude");
  vi.stubEnv("ANTHROPIC_API_KEY", CLAUDE_KEY);
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("POST /api/campaigns/ai-generate — monthly AI cap (R-1877)", () => {
  it("cap 2: calls 1 and 2 are written by the AI, call 3 → 429 with the reason, Claude not asked", async () => {
    const r1 = await call();
    expect(r1.status).toBe(200);
    expect((await r1.json()).mode).toBe("gemini");
    const r2 = await call();
    expect(r2.status).toBe(200);
    expect(h.createMock).toHaveBeenCalledTimes(2);

    const r3 = await call();
    expect(r3.status).toBe(429);
    const body = await r3.json();
    expect(body.code).toBe("ai_cap_reached");
    expect(body.error).toContain("2 of 2");
    expect(h.createMock).toHaveBeenCalledTimes(2);   // the third call never reached Claude
  });
});
