/**
 * R-1425 — the Gemini helper line says what the shared key means: it is shared by every
 * workspace on this server, its daily quota can run out, and a free key's real limit.
 */
import { describe, it, expect } from "vitest";
import { geminiStatusText, GEMINI_FREE_TIER_REQUESTS_PER_DAY } from "./gemini-status-text";

describe("geminiStatusText", () => {
  it("own key → live", () => {
    expect(geminiStatusText({ configured: true, envFallback: true }).card).toBe("Real AI drafts + extraction");
  });

  it("shared key → says it is shared, can run out, and the real free-tier limit", () => {
    const t = geminiStatusText({ configured: false, envFallback: true });
    expect(t.card).toMatch(/shared server key/i);
    expect(t.detail).toMatch(/every workspace on this server/i);
    expect(t.detail).toMatch(/run out/i);
    expect(t.detail).toContain(`${GEMINI_FREE_TIER_REQUESTS_PER_DAY} requests a day per model`);
    expect(t.detail).toMatch(/add your own key/i);
  });

  it("no key anywhere → templates only, next step named", () => {
    const t = geminiStatusText({ configured: false, envFallback: false });
    expect(t.card).toMatch(/templates only/i);
    expect(t.detail).toMatch(/add a gemini key/i);
  });

  it("the free-tier number is the one measured in lib/ai/gemini.ts", () => {
    expect(GEMINI_FREE_TIER_REQUESTS_PER_DAY).toBe(20);
  });
});
