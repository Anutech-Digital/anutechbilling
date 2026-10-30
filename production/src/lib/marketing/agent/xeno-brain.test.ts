/**
 * R-2159 (G-ADS-AI, AI-03) — Xeno's real AI door: every call reserves the company's AI cap
 * (R-1877, ai_usage_reserve) BEFORE the provider is asked; refused → the provider is never
 * called and Xeno gets "cap". The provider (fetch) and the counter (usage-cap) are fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  order: [] as string[],
  allowed: true,
  reserveArgs: [] as unknown[][],
}));

vi.mock("@/lib/ai/usage-cap", () => ({
  reserveAiCall: async (...args: unknown[]) => {
    h.order.push("reserve");
    h.reserveArgs.push(args);
    return h.allowed
      ? { allowed: true, used: 1, cap: 50, month: "2026-10-01" }
      : { allowed: false, used: 50, cap: 50, month: "2026-10-01", message: "Your company has used this month's AI limit (50 of 50 AI calls)." };
  },
  recordAiTokens: async () => { h.order.push("tokens"); },
}));

import { XENO_AI_LABEL, xenoBrain } from "./xeno-brain";

const TENANT = "dddddddd-0000-4000-8000-000000215902";
const prompt = { system: "Output ONLY JSON", user: "Sentence: Launch a campaign" };
const geminiReply = (json: unknown) => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
}), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  h.order = []; h.allowed = true; h.reserveArgs = [];
  vi.stubGlobal("fetch", vi.fn(async () => { h.order.push("provider"); return geminiReply({ objective: "sales", goalStated: true }); }));
});
afterEach(() => vi.unstubAllGlobals());

describe("xenoBrain — the AI cap is reserved before every call", () => {
  it("reserves for THIS company under the Xeno label, then asks the provider, then records tokens", async () => {
    const brain = xenoBrain({ tenantId: TENANT, apiKey: "AIza-test-key-0000000000000000000000", model: "gemini-test" });
    const r = await brain.ask(prompt);
    expect(r).toEqual({ kind: "ok", raw: { objective: "sales", goalStated: true } });
    expect(h.order).toEqual(["reserve", "provider", "tokens"]);
    expect(h.reserveArgs[0].slice(0, 2)).toEqual([TENANT, XENO_AI_LABEL]);
  });

  it("cap used up → the provider is never asked; Xeno gets the reason", async () => {
    h.allowed = false;
    const brain = xenoBrain({ tenantId: TENANT, apiKey: "AIza-test-key-0000000000000000000000", model: "gemini-test" });
    const r = await brain.ask(prompt);
    expect(r).toMatchObject({ kind: "cap", message: expect.stringMatching(/AI limit/) });
    expect(fetch).not.toHaveBeenCalled();
    expect(h.order).toEqual(["reserve"]);
  });

  it("no AI key → nothing is reserved or asked", async () => {
    const r = await xenoBrain({ tenantId: TENANT, apiKey: null, model: "gemini-test" }).ask(prompt);
    expect(r).toMatchObject({ kind: "none" });
    expect(h.order).toEqual([]);
  });

  it("provider fails → 'none' with a reason (Xeno falls back to the words), the call was still reserved first", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { h.order.push("provider"); return new Response("nope", { status: 400 }); }));
    const r = await xenoBrain({ tenantId: TENANT, apiKey: "AIza-test-key-0000000000000000000000", model: "gemini-test" }).ask(prompt);
    expect(r).toMatchObject({ kind: "none" });
    expect(h.order[0]).toBe("reserve");
  });
});
