/**
 * R-2649 (10 Nov 2026) — one source-tree walk for the repo-scan guard tests.
 *
 * Why: app-url.test.ts walked src/ twice (once per scan test) and no-seed-tenant.test.ts once more,
 * each with a statSync on every one of ~5,000 entries. Same list every time. Here the walk uses
 * `readdirSync(withFileTypes)` (no stat per entry) and is memoised per directory for the life of the
 * test file's process, so a file with two scans walks once.
 *
 * Same files as the old walkers: directories are followed (a symlink is resolved with statSync, as
 * before), Prisma's generated client is skipped (R-2564), and `node_modules` / `.next` are skipped
 * (src/ has neither; the old no-seed-tenant walker skipped them too). Paths come back joined from
 * `dir` exactly as given — relative in, relative out. Filter by name with the `keep` callback.
 *
 * Test-only: imported by *.test.ts files (and the guard-run warm-up), never by app code.
 */
import fs from "node:fs";
import path from "node:path";
import { isPrismaGenerated } from "./prisma-generated";

const SKIP_DIRS = new Set(["node_modules", ".next"]);
const memo = new Map<string, string[]>();

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const isDir = e.isDirectory() || (e.isSymbolicLink() && fs.statSync(p).isDirectory());
    if (isDir) {
      if (!SKIP_DIRS.has(e.name) && !isPrismaGenerated(p)) walk(p, out);
    } else out.push(p);
  }
}

/** Every file under `dir` (generated Prisma client, node_modules and .next skipped) whose base name
    passes `keep`. The walk runs once per `dir` per process; the result is a fresh array each call. */
export function listSourceFiles(dir: string, keep: (name: string) => boolean = () => true): string[] {
  let all = memo.get(dir);
  if (!all) { all = []; walk(dir, all); memo.set(dir, all); }
  return all.filter((f) => keep(path.basename(f)));
}

/** Test hook: forget the memoised walks. */
export function resetSourceWalkForTest(): void {
  memo.clear();
}
