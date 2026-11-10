/**
 * R-2564 / R-2630 / R-2649 — the shared, always-fresh read cache for repo-scan guard tests.
 * All the logic (and the why) is in ./source-cache-core.ts. This module is what test files import:
 * it re-exports the core and registers the once-per-test-file flush (afterAll). The core imports
 * nothing from vitest so the guard run's globalSetup (warm-source-cache.ts) can use it too.
 *
 * Test-only: imported by *.test.ts files (and test-only scanners), never by app code.
 */
import { afterAll } from "vitest";
import { flushSourceCache } from "./source-cache-core";

export * from "./source-cache-core";

/* Registered when a test file imports this module (its collection phase), so it runs once after
   that file's tests. Outside a vitest collection (a plain script) the caller flushes. */
try { afterAll(() => flushSourceCache()); } catch { /* not inside a test file */ }
