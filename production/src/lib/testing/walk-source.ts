/**
 * R-2649 (10 Nov 2026) — one source-tree walk for the repo-scan guard tests.
 *
 * Why: app-url.test.ts walked src/ twice and no-seed-tenant.test.ts once more, each with a statSync on
 * every one of ~5,000 entries. This walk uses `readdirSync(withFileTypes)` — no stat per entry (a
 * symlink is still resolved with statSync, as the old walkers did) — and skips only Prisma's generated
 * client (R-2564: not our code, 36 MB). Nothing is memoised here: a caller that scans twice keeps its
 * own list, so a file written later is never silently missing from a fresh call.
 * Paths come back joined from `dir` exactly as given — relative in, relative out. Filter by base name
 * with `keep`.
 *
 * Test-only: imported by *.test.ts files (and the guard-run warm-up), never by app code.
 */
import fs from "node:fs";
import path from "node:path";
import { isPrismaGenerated } from "./prisma-generated";

function walk(dir: string, keep: (name: string) => boolean, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const isDir = e.isDirectory() || (e.isSymbolicLink() && fs.statSync(p).isDirectory());
    if (isDir) { if (!isPrismaGenerated(p)) walk(p, keep, out); }
    else if (keep(e.name)) out.push(p);
  }
}

/** Every file under `dir` (the generated Prisma client skipped) whose base name passes `keep`. */
export function listSourceFiles(dir: string, keep: (name: string) => boolean = () => true): string[] {
  const out: string[] = [];
  walk(dir, keep, out);
  return out;
}
