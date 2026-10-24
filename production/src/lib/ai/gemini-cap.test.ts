/**
 * R-1877 — the per-company AI cap is enforced in the one AI door (geminiJson /
 * geminiGroundedText), BEFORE the provider is asked. The Anthropic SDK and fetch are mocked;
 * no real AI call is ever made here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { createMock, reserveMock, tokensMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  reserveMock: vi.fn(),
  tokensMock: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  class FakeAnthropic extends real.default {
    constructor(opts: ConstructorParameters<typeof real.default>[0]) {
      super(opts);
      (this as unknown as { messages: unknown }).messages = { create: createMock };
    }
  }
  return { ...real, default: FakeAnthropic };
});

vi.mock("./usage-cap", () => ({
  reserveAiCall: reserveMock,
  recordAiTokens: tokensMock,
}));

import { geminiJson, geminiGroundedText, __resetGeminiBreaker } from "./gemini";
import { __resetClaudeBreaker } from "./claude";

const CLAUDE_KEY = "sk-ant-test-" + "c".repeat(20);
const GEMINI_SERVER_KEY = "AQ.server-" + "g".repeat(20);
const GEMINI_OWN_KEY = "AQ.own-" + "o".repeat(20);
const CAPPED = { allowed: false, used: 2, cap: 2, month: "2026-10-01", message: "Your company has used this month's AI limit (2 of 2 AI calls)." };
const OPEN = { allowed: true, used: 1, cap: 2, month: "2026-10-01" };

function geminiOk(text: string, usage?: { promptTokenCount: number; candidatesTokenCount: number }) {
  return {
    ok: true, status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }], ...(usage ? { usageMetadata: usage } : {}) }),
    text: async () => "",
  } as unknown as Response;
}

beforeEach(() => {
  __resetGeminiBreaker();
  __resetClaudeBreaker();
  createMock.mockReset();
  reserveMock.mockReset();
  tokensMock.mockReset();
  tokensMock.mockResolvedValue(undefined);
  vi.stubEnv("AI_PROVIDER", "");
  vi.stubEnv("ANTHROPIC_API_KEY", CLAUDE_KEY);
  vi.stubEnv("GEMINI_API_KEY", GEMINI_SERVER_KEY);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("cap reached → no AI call, a clear reason", () => {
  it("Claude (server key): third call refused before Claude is asked", async () => {
    reserveMock.mockResolvedValue(CAPPED);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const why: string[] = [];
    const r = await geminiJson({ apiKey: CLAUDE_KEY, model: "claude-opus-5-5", user: "u", label: "copilot/copy", tenantId: "t1", onFailure: (w) => why.push(w) });
    expect(r).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();          // no Gemini fallback either
    expect(reserveMock).toHaveBeenCalledWith("t1", "copilot/copy", true);
    expect(why).toEqual([CAPPED.message]);
  });

  it("onCapReached tells the caller it was the cap (so a route can answer 429, not a stub)", async () => {
    reserveMock.mockResolvedValue(CAPPED);
    const capped: string[] = [];
    await geminiJson({ apiKey: CLAUDE_KEY, model: "m", user: "u", label: "x", tenantId: "t1", onCapReached: (m) => capped.push(m) });
    expect(capped).toEqual([CAPPED.message]);
  });

  it("Gemini (server key) is capped too", async () => {
    reserveMock.mockResolvedValue(CAPPED);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await geminiJson({ apiKey: GEMINI_SERVER_KEY, model: "gemini-flash-latest", user: "u", label: "ai/test", tenantId: "t1" });
    expect(r).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reserveMock).toHaveBeenCalledWith("t1", "ai/test", true);
  });

  it("web search (geminiGroundedText) refuses with the same reason", async () => {
    reserveMock.mockResolvedValue(CAPPED);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(geminiGroundedText({ apiKey: GEMINI_SERVER_KEY, model: "m", system: "s", user: "u", label: "leads/finder", tenantId: "t1" }))
      .rejects.toThrow(CAPPED.message);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("under the cap → the call runs and is counted", () => {
  it("Gemini: counted once, tokens recorded from usageMetadata", async () => {
    reserveMock.mockResolvedValue(OPEN);
    vi.stubGlobal("fetch", vi.fn(async () => geminiOk('{"a":1}', { promptTokenCount: 120, candidatesTokenCount: 30 })));
    await expect(geminiJson({ apiKey: GEMINI_SERVER_KEY, model: "m", user: "u", label: "ai/test", tenantId: "t1" })).resolves.toEqual({ a: 1 });
    expect(reserveMock).toHaveBeenCalledTimes(1);
    expect(tokensMock).toHaveBeenCalledWith("t1", "ai/test", { inputTokens: 120, outputTokens: 30 });
  });

  it("Claude: tokens recorded from usage", async () => {
    reserveMock.mockResolvedValue(OPEN);
    createMock.mockResolvedValue({ content: [{ type: "text", text: '{"b":2}' }], stop_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 80 } });
    await expect(geminiJson({ apiKey: CLAUDE_KEY, model: "claude-opus-5-5", user: "u", label: "copilot/copy", tenantId: "t1" })).resolves.toEqual({ b: 2 });
    expect(tokensMock).toHaveBeenCalledWith("t1", "copilot/copy", { inputTokens: 900, outputTokens: 80 });
  });

  it("Claude fails over to Gemini → still ONE call counted, both providers' tokens added", async () => {
    reserveMock.mockResolvedValue(OPEN);
    const { RateLimitError } = await import("@anthropic-ai/sdk");
    createMock.mockRejectedValue(new RateLimitError(429, { type: "error" }, "rate", new Headers()));
    vi.stubGlobal("fetch", vi.fn(async () => geminiOk('{"c":3}', { promptTokenCount: 50, candidatesTokenCount: 5 })));
    await expect(geminiJson({ apiKey: CLAUDE_KEY, model: "claude-opus-5-5", user: "u", label: "ai/test", tenantId: "t1" })).resolves.toEqual({ c: 3 });
    expect(reserveMock).toHaveBeenCalledTimes(1);
    expect(tokensMock).toHaveBeenCalledWith("t1", "ai/test", { inputTokens: 50, outputTokens: 5 });
  });

  it("the company's OWN Gemini key is counted but never refused (enforce = false)", async () => {
    reserveMock.mockResolvedValue(OPEN);
    vi.stubGlobal("fetch", vi.fn(async () => geminiOk('{"d":4}')));
    await geminiJson({ apiKey: GEMINI_OWN_KEY, model: "m", user: "u", label: "ai/test", tenantId: "t1" });
    expect(reserveMock).toHaveBeenCalledWith("t1", "ai/test", false);
  });
});

describe("no company (system job) → nothing to count", () => {
  it("tenantId null skips the counter", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => geminiOk('{"e":5}')));
    await expect(geminiJson({ apiKey: GEMINI_SERVER_KEY, model: "m", user: "u", label: "ai/test", tenantId: null })).resolves.toEqual({ e: 5 });
    expect(reserveMock).not.toHaveBeenCalled();
    expect(tokensMock).not.toHaveBeenCalled();
  });
});
