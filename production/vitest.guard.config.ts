/**
 * R-2649 (10 Nov 2026) — the config `worker-lock.mjs push` runs the guard files with: the normal
 * vitest.config.ts plus a globalSetup that warms the shared source cache once before the forks start
 * (src/lib/testing/warm-source-cache.ts — cold 135 s vs warm 28 s for the same 88 files).
 * Everything else (aliases, include/exclude, plugins) is the base config, unchanged.
 */
import { mergeConfig } from "vitest/config";
import base from "./vitest.config";

export default mergeConfig(base, {
  test: { globalSetup: ["./src/lib/testing/warm-source-cache.ts"] },
});
