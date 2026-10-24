/**
 * R-1425 — what the AI assistant card and its dialog say about the Gemini key.
 *
 * "Using shared server key" (Pawan, staging 12 Oct 2026) did not say what that means: the
 * key is the deployment's GEMINI_API_KEY, shared by every workspace on this server, so its
 * daily quota can run out for everyone at once. A free Gemini key's limit is the one
 * measured in lib/ai/gemini.ts (429 RESOURCE_EXHAUSTED at 20 requests/day/model).
 */

export const GEMINI_FREE_TIER_REQUESTS_PER_DAY = 20;

export interface GeminiStatusText {
  /** One short line on the Settings card. */
  card: string;
  /** The fuller helper line in the dialog. */
  detail: string;
}

export function geminiStatusText(s: { configured: boolean; envFallback: boolean }): GeminiStatusText {
  if (s.configured) {
    return { card: "Real AI drafts + extraction", detail: "Your own Gemini key is in use. Its limits are the ones on your Google AI Studio plan." };
  }
  if (s.envFallback) {
    return {
      card: "Using the shared server key · add your own for steady use",
      detail:
        "Using the shared server key. Every workspace on this server shares its daily quota, so AI drafts can pause until tomorrow once it has run out "
        + `(a free Gemini key allows about ${GEMINI_FREE_TIER_REQUESTS_PER_DAY} requests a day per model). `
        + "Add your own key below to get your own quota.",
    };
  }
  return {
    card: "Templates only — add a Gemini key",
    detail: "No key on this workspace or server, so AI features run on plain templates. Add a Gemini key below to turn on AI drafts.",
  };
}

/**
 * R-1759 — the one line on the AI card that says which AI actually runs. Never shows a key.
 * Claude has only a server key (ANTHROPIC_API_KEY); Gemini can be the workspace's own key
 * (Settings) or the server's.
 */
export function aiUsingLine(s: { provider: "claude" | "gemini" | null; tenantGeminiKey: boolean }): string {
  if (s.provider === "claude") return "AI is using: Claude (server key)";
  if (s.provider === "gemini") return s.tenantGeminiKey ? "AI is using: Gemini (your key)" : "AI is using: Gemini (server key)";
  return "AI is using: templates only (no AI key)";
}

/** R-1759 — the fuller line when Claude runs (hover on the card, and the dialog). */
export const CLAUDE_STATUS_DETAIL =
  "AI runs on Claude with the server's key, chosen on the server (AI_PROVIDER). If Claude fails, the server Gemini key (if there is one) is tried once. "
  + "A Gemini key saved here is used only when the server is set to Gemini.";
