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
