/**
 * Sandbox.co.in base URL vs API key (R-2168). Pure — no node imports, so the Settings dialog
 * and the server routes share one rule. safe-fetch.ts re-exports these.
 */
export const SANDBOX_DEFAULT_BASE = "https://api.sandbox.co.in";

/* R-2168: Sandbox issues key_test_… keys for test-api.sandbox.co.in and key_live_… keys for
   api.sandbox.co.in; the wrong pair answers 403 "Use test API key for test environment". */
export const SANDBOX_TEST_BASE = "https://test-api.sandbox.co.in";

/** "test" / "live" from the key prefix; null for any other key (left as saved). */
export function sandboxKeyKind(apiKey: string): "test" | "live" | null {
  const k = apiKey.trim();
  if (k.startsWith("key_test_")) return "test";
  if (k.startsWith("key_live_")) return "live";
  return null;
}

function trimBase(base: string | null | undefined): string {
  return (base ?? "").trim().replace(/\/+$/, "");
}

/** The base URL to use: blank or the default follows the key prefix; anything else as saved. */
export function sandboxBaseForKey(apiKey: string, savedBase: string | null | undefined): string {
  const base = trimBase(savedBase);
  if (!base || base === SANDBOX_DEFAULT_BASE) {
    const kind = sandboxKeyKind(apiKey);
    if (kind === "test") return SANDBOX_TEST_BASE;
    if (kind === "live") return SANDBOX_DEFAULT_BASE;
  }
  return base || SANDBOX_DEFAULT_BASE;
}

/** null when the key and base URL belong together, else a §24 message (never the key itself). */
export function sandboxKeyBaseProblem(apiKey: string, savedBase: string | null | undefined): string | null {
  const kind = sandboxKeyKind(apiKey);
  if (!kind) return null;
  const base = sandboxBaseForKey(apiKey, savedBase);
  if (kind === "live" && base === SANDBOX_TEST_BASE) {
    return `This is a live API key (key_live_…), but the base URL is the Sandbox test address. `
      + `Clear the API base URL (or set ${SANDBOX_DEFAULT_BASE}) and Save — or use a test key (key_test_…) for the test address.`;
  }
  return null;
}
