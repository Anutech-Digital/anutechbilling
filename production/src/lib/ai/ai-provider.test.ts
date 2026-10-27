/**
 * R-1759 — AI provider switch: Claude (Anthropic) or Gemini, chosen by env; if one fails, the
 * other is tried once.
 *
 * Owner's real path (Pardeep, staging 22 Oct 2026): Gemini answered 429 "billing account has
 * exceeded its monthly spending cap", so reading a bill PDF in Expenses failed. With
 * AI_PROVIDER=claude + ANTHROPIC_API_KEY the same bill must be read by Claude, and with
 * AI_PROVIDER=gemini the old path must stay — no code change to switch back.
 *
 * The Anthropic SDK is mocked: no real network call is ever made here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

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

import { APIError } from "@anthropic-ai/sdk";
import { geminiJson, resolveGeminiConfig, __resetGeminiBreaker } from "./gemini";
import { resolveAiProvider, DEFAULT_CLAUDE_MODEL, __resetClaudeBreaker } from "./claude";
import { aiUsingLine } from "./gemini-status-text";

const CLAUDE_KEY = "sk-ant-test-" + "c".repeat(20);
const GEMINI_KEY = "AQ.test-" + "g".repeat(20);

function claudeReply(text: string, stop_reason = "end_turn") {
  return { content: [{ type: "text", text }], stop_reason, stop_details: null };
}

function geminiOk(text: string) {
  return {
    ok: true, status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
    text: async () => "",
  } as unknown as Response;
}

function gemini429() {
  return {
    ok: false, status: 429,
    text: async () => JSON.stringify({ error: { message: "Your project has exceeded its monthly spending cap." } }),
    json: async () => ({}),
  } as unknown as Response;
}

/** Minimal Supabase stub: tenant_secrets row for the tenant (or none). */
function client(row: { gemini_api_key?: string | null; gemini_model?: string | null } | null) {
  return {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row }) }) }) }),
  } as never;
}

beforeEach(() => {
  __resetGeminiBreaker();
  __resetClaudeBreaker();
  createMock.mockReset();
  vi.stubEnv("AI_PROVIDER", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("ANTHROPIC_MODEL", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("GEMINI_MODEL", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveAiProvider — which AI runs", () => {
  it.each([
    // [AI_PROVIDER, gemini key?, claude key?, expected]
    ["", true, false, "gemini"],
    ["", false, true, "claude"],
    ["", true, true, "gemini"],          // both keys, nothing chosen → today's behaviour
    ["", false, false, null],
    ["claude", true, true, "claude"],
    ["gemini", true, true, "gemini"],
    ["CLAUDE", true, true, "claude"],    // case does not matter
    ["claude", true, false, "gemini"],   // chosen one has no key → the one that has
    ["gemini", false, true, "claude"],
    ["openai", true, true, "gemini"],    // unknown value → as if unset
  ] as const)("AI_PROVIDER=%j gemini=%s claude=%s → %s", (choice, g, c, want) => {
    expect(resolveAiProvider({ choice, hasGemini: g, hasClaude: c })).toBe(want);
  });
});

describe("resolveGeminiConfig — provider from env", () => {
  it("AI_PROVIDER=claude + Anthropic key → Claude, default model claude-opus-5-5", async () => {
    vi.stubEnv("AI_PROVIDER", "claude");
    vi.stubEnv("ANTHROPIC_API_KEY", CLAUDE_KEY);
    vi.stubEnv("GEMINI_API_KEY", GEMINI_KEY);
    const cfg = await resolveGeminiConfig(client(null), "t1");
    expect(cfg).toMatchObject({ provider: "claude", apiKey: CLAUDE_KEY, model: "claude-opus-5-5" });
    expect(DEFAULT_CLAUDE_MODEL).toBe("claude-opus-5-5");
  });

  it("ANTHROPIC_MODEL overrides the Claude model", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", CLAUDE_KEY);
    vi.stubEnv("ANTHROPIC_MODEL", "claude-sonnet-5-5");
    const cfg = await resolveGeminiConfig(client(null), "t1");
    expect(cfg).toMatchObject({ provider: "claude", model: "claude-sonnet-5-5" });
  });

  it("the tenant's Settings Gemini key does not override AI_PROVIDER=claude", async () => {
    vi.stubEnv("AI_PROVIDER", "claude");
    vi.stubEnv("ANTHROPIC_API_KEY", CLAUDE_KEY);
    const cfg = await resolveGeminiConfig(client({ gemini_api_key: "tenant-" + "x".repeat(20) }), "t1");
    expect(cfg.provider).toBe("claude");
    expect(cfg.apiKey).toBe(CLAUDE_KEY);
    expect(cfg.geminiKey).toBe("tenant-" + "x".repeat(20));
  });

  it("AI_PROVIDER=gemini → the old path: tenant key wins over env, Gemini model", async () => {
    vi.stubEnv("AI_PROVIDER", "gemini");
    vi.stubEnv("ANTHROPIC_API_KEY", CLAUDE_KEY);
    vi.stubEnv("GEMINI_API_KEY", GEMINI_KEY);
    const cfg = await resolveGeminiConfig(client({ gemini_api_key: "tenant-" + "x".repeat(20), gemini_model: "gemini-3.6-flash" }), "t1");
    expect(cfg).toMatchObject({ provider: "gemini", apiKey: "tenant-" + "x".repeat(20), model: "gemini-3.6-flash" });
  });

  it("no key anywhere → apiKey null (callers use their templates)", async () => {
    const cfg = await resolveGeminiConfig(client(null), "t1");
    expect(cfg.apiKey).toBeNull();
    expect(cfg.provider).toBeNull();
  });
});

describe("geminiJson on Claude", () => {
  beforeEach(() => {
    vi.stubEnv("AI_PROVIDER", "claude");
    vi.stubEnv("ANTHROPIC_API_KEY", CLAUDE_KEY);
  });

  it("bill PDF → document block BEFORE the text; no thinking/temperature; effort low; JSON parsed", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    createMock.mockResolvedValue(claudeReply('```json\n{"vendor_name":"Acme","total":1180}\n```'));
    const bill = await geminiJson<{ vendor_name: string; total: number }>({
      apiKey: CLAUDE_KEY, model: "claude-opus-5-5", user: "Read this bill", tenantId: null, label: "ai/extract-bill",
      temperature: 0.1, attachment: { mimeType: "application/pdf", base64: "JVBERi0x" },
    });
    expect(bill).toEqual({ vendor_name: "Acme", total: 1180 });
    expect(fetchSpy).not.toHaveBeenCalled();                     // Gemini not asked
    const [body, opts] = createMock.mock.calls[0];
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.output_config).toEqual({ effort: "low" });
    const content = body.messages[0].content;
    expect(content[0]).toEqual({ type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0x" } });
    expect(content[content.length - 1].type).toBe("text");
    expect(content[content.length - 1].text).toContain("Read this bill");
    expect(body.messages).toHaveLength(1);                        // no assistant prefill
    expect(opts.timeout).toBeGreaterThanOrEqual(60_000);          // attachment → long timeout
  });

  it("image → image block", async () => {
    createMock.mockResolvedValue(claudeReply('{"ok":true}'));
    await geminiJson({ apiKey: CLAUDE_KEY, model: "claude-opus-5-5", user: "u", tenantId: null, label: "t", attachment: { mimeType: "image/png", base64: "iVBO" } });
    expect(createMock.mock.calls[0][0].messages[0].content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBO" } });
  });

  it("a Gemini model name passed by a caller is replaced by the Claude model", async () => {
    createMock.mockResolvedValue(claudeReply('{"ok":true}'));
    await geminiJson({ apiKey: CLAUDE_KEY, model: "gemini-3.6-flash", user: "u", tenantId: null, label: "t" });
    expect(createMock.mock.calls[0][0].model).toBe("claude-opus-5-5");
  });

  it("JSON arrays come back too", async () => {
    createMock.mockResolvedValue(claudeReply('Here you go:\n[{"a":1},{"a":2}]'));
    await expect(geminiJson({ apiKey: CLAUDE_KEY, model: "claude-opus-5-5", user: "u", tenantId: null, label: "t" })).resolves.toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("bad JSON → null with a reason", async () => {
    createMock.mockResolvedValue(claudeReply("Sorry, I cannot read that."));
    const onFailure = vi.fn();
    await expect(geminiJson({ apiKey: CLAUDE_KEY, model: "claude-opus-5-5", user: "u", tenantId: null, label: "t", onFailure })).resolves.toBeNull();
    expect(onFailure).toHaveBeenCalledWith(expect.stringMatching(/Claude.*not valid JSON/i));
  });

  it("refusal → null with a reason, content not read", async () => {
    createMock.mockResolvedValue(claudeReply('{"x":1}', "refusal"));
    const onFailure = vi.fn();
    await expect(geminiJson({ apiKey: CLAUDE_KEY, model: "claude-opus-5-5", user: "u", tenantId: null, label: "t", onFailure })).resolves.toBeNull();
    expect(onFailure).toHaveBeenCalledWith(expect.stringMatching(/Claude declined/i));
  });

  it("max_tokens → null with a reason", async () => {
    createMock.mockResolvedValue(claudeReply('{"x":', "max_tokens"));
    const onFailure = vi.fn();
    await expect(geminiJson({ apiKey: CLAUDE_KEY, model: "claude-opus-5-5", user: "u", tenantId: null, label: "t", onFailure })).resolves.toBeNull();
    expect(onFailure).toHaveBeenCalledWith(expect.stringMatching(/cut off/i));
  });

  it("401 → clear reason, null (no Gemini key to fall back to)", async () => {
    createMock.mockRejectedValue(APIError.generate(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, "invalid x-api-key", new Headers()));
    const onFailure = vi.fn();
    await expect(geminiJson({ apiKey: CLAUDE_KEY, model: "claude-opus-5-5", user: "u", tenantId: null, label: "t", onFailure })).resolves.toBeNull();
    expect(onFailure).toHaveBeenCalledWith(expect.stringMatching(/Claude API key was refused/));
  });

  it("Claude 429 + server Gemini key → Gemini answers", async () => {
    vi.stubEnv("GEMINI_API_KEY", GEMINI_KEY);
    createMock.mockRejectedValue(APIError.generate(429, { type: "error", error: { type: "rate_limit_error", message: "credit balance too low" } }, "rate", new Headers()));
    const fetchSpy = vi.fn(async () => geminiOk('{"from":"gemini"}'));
    vi.stubGlobal("fetch", fetchSpy);
    const onFailure = vi.fn();
    await expect(geminiJson({ apiKey: CLAUDE_KEY, model: "claude-opus-5-5", user: "u", tenantId: null, label: "t", onFailure })).resolves.toEqual({ from: "gemini" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toContain("generativelanguage.googleapis.com");
    expect(onFailure).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("[t] claude 429 → trying gemini"));
  });
});

describe("fallback from Gemini to Claude", () => {
  it("Gemini 429 (spending cap) + Anthropic key → Claude reads the bill", async () => {
    vi.stubEnv("AI_PROVIDER", "gemini");
    vi.stubEnv("ANTHROPIC_API_KEY", CLAUDE_KEY);
    vi.stubGlobal("fetch", vi.fn(async () => gemini429()));
    createMock.mockResolvedValue(claudeReply('{"vendor_name":"Acme"}'));
    const onFailure = vi.fn();
    const r = await geminiJson({ apiKey: GEMINI_KEY, model: "gemini-flash-latest", user: "u", tenantId: null, label: "ai/extract-bill", onFailure, attachment: { mimeType: "application/pdf", base64: "JVBE" } });
    expect(r).toEqual({ vendor_name: "Acme" });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0].model).toBe("claude-opus-5-5");
    expect(onFailure).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("[ai/extract-bill] gemini 429 → trying claude"));
  });

  it("Gemini 429 and no Anthropic key → null with the Gemini reason (old behaviour)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => gemini429()));
    const onFailure = vi.fn();
    await expect(geminiJson({ apiKey: GEMINI_KEY, model: "gemini-flash-latest", user: "u", tenantId: null, label: "t", onFailure })).resolves.toBeNull();
    expect(createMock).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith(expect.stringMatching(/Gemini quota/));
  });

  it("both fail → one reason naming both", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", CLAUDE_KEY);
    vi.stubGlobal("fetch", vi.fn(async () => gemini429()));
    createMock.mockRejectedValue(APIError.generate(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, "Overloaded", new Headers()));
    const onFailure = vi.fn();
    await expect(geminiJson({ apiKey: GEMINI_KEY, model: "gemini-flash-latest", user: "u", tenantId: null, label: "t", onFailure })).resolves.toBeNull();
    expect(createMock).toHaveBeenCalledTimes(1);                  // tried once, no ping-pong
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0]).toMatch(/Gemini quota/);
    expect(onFailure.mock.calls[0][0]).toMatch(/Claude is overloaded/);
  });
});

describe("aiUsingLine — Settings → Integrations AI card", () => {
  it.each([
    [{ provider: "claude", tenantGeminiKey: false }, "AI is using: Claude (server key)"],
    [{ provider: "claude", tenantGeminiKey: true }, "AI is using: Claude (server key)"],
    [{ provider: "gemini", tenantGeminiKey: true }, "AI is using: Gemini (your key)"],
    [{ provider: "gemini", tenantGeminiKey: false }, "AI is using: Gemini (server key)"],
    [{ provider: null, tenantGeminiKey: false }, "AI is using: templates only (no AI key)"],
  ] as const)("%j → %s", (s, want) => {
    expect(aiUsingLine(s)).toBe(want);
  });
});
