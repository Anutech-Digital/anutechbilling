/**
 * R-2649 (10 Nov 2026) — warm the shared source cache ONCE before the push's guard run.
 *
 * Measured 10 Nov, same 88 guard files, laptop with other workers running: a worktree whose cache is
 * cold (every worker's push — the worktree is new and the fast gate does not run these files) took
 * 135.3 s, app-url 116.9 s / secret-columns 77.6 s / no-seed-tenant 53.4 s; the very same run with a
 * warm cache took 28.4 s. Cold, ~20 forks each open and read the same ~5,000 src/ files at once
 * (one process alone needs 4.6–8.9 s for that on this Windows laptop) and nobody's afterAll flush
 * helps the others in time. Here ONE process reads them first and writes the cache, so every fork
 * starts warm. Warm already, this is a stat per file (~0.2 s).
 *
 * Used as `globalSetup` by vitest.guard.config.ts (worker-lock.mjs push → runGuardSuites). It only
 * fills the cache — readSource() still checks size+mtime+ctime (and racy entries) on every read, so a
 * scan never sees stale text. A failure here only costs speed, never a red guard.
 */
import path from "node:path";
import { PRODUCTION_ROOT } from "./prisma-generated";
import { flushSourceCache, readSource } from "./source-cache";
import { listSourceFiles } from "./walk-source";

/** What the guard scans read most: our TS source under src/ and the SQL under supabase/. */
export const WARM_TARGETS: ReadonlyArray<{ dir: string; ext: RegExp }> = [
  { dir: "src", ext: /\.(ts|tsx)$/ },
  { dir: "supabase", ext: /\.sql$/ },
];

/** Read every target file through readSource and write the cache. Returns how many files it read. */
export function warmSourceCache(root: string = PRODUCTION_ROOT): number {
  let n = 0;
  for (const { dir, ext } of WARM_TARGETS) {
    let files: string[] = [];
    try { files = listSourceFiles(path.join(root, dir), (name) => ext.test(name)); } catch { continue; }
    for (const f of files) {
      try { readSource(f); n++; } catch { /* gone between walk and read — the scan will see that itself */ }
    }
  }
  flushSourceCache();
  return n;
}

/** vitest globalSetup entry. */
export default function setup(): void {
  const t0 = Date.now();
  try {
    const n = warmSourceCache();
    if (process.env.SOURCE_CACHE_WARM_LOG) console.log(`(source cache warm: ${n} files, ${Date.now() - t0} ms)`);
  } catch { /* cache is only for speed */ }
}
