/**
 * R-2159 (G-ADS-AI, AI-03) — Xeno's real AI door.
 *
 * Every call goes through geminiJson (lib/ai/gemini.ts) with the company's tenantId, so the
 * company's monthly AI cap (R-1877: ai_usage_reserve) is reserved BEFORE the provider is
 * asked, and the tokens are recorded after. Cap used up → the provider is never called and
 * Xeno gets { kind: "cap" } (it then drafts from the words). No key / AI failed → "none".
 * The caller resolves the key (resolveGeminiConfig) — see app/api/marketing/agent/agent-io.ts.
 */
import "server-only";
import { geminiJson } from "@/lib/ai/gemini";
import type { XenoAiResult, XenoBrain } from "./xeno";

/** The `feature` Xeno's calls are counted under in ai_usage (and the server-log prefix). */
export const XENO_AI_LABEL = "marketing/agent-xeno";

export function xenoBrain(cfg: { tenantId: string; apiKey: string | null; model: string }): XenoBrain {
  return {
    async ask(prompt): Promise<XenoAiResult> {
      if (!cfg.apiKey) return { kind: "none", reason: "No AI key is set up" };
      let cap: string | null = null;
      let why = "";
      const raw = await geminiJson<unknown>({
        apiKey: cfg.apiKey, model: cfg.model, tenantId: cfg.tenantId,
        system: prompt.system, user: prompt.user, temperature: 0.2, label: XENO_AI_LABEL,
        onCapReached: (m) => { cap = m; },
        onFailure: (m) => { why = m; },
      });
      if (cap) return { kind: "cap", message: cap };
      if (raw && typeof raw === "object" && !Array.isArray(raw)) return { kind: "ok", raw };
      return { kind: "none", reason: why ? "the AI did not answer" : "the AI gave no usable answer" };
    },
  };
}
