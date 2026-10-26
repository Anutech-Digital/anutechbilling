/**
 * R-1960 (26 Oct 2026): a shared tsc build-info cache for worker worktrees.
 *
 * Measured on the real repo (laptop, 26 Oct): a fresh worktree's `tsc --noEmit` took 525 s; the
 * SAME worktree's second run took 78 s, because tsconfig.json already has `incremental: true` and
 * tsc reuses `tsconfig.tsbuildinfo`. Every card started in a NEW worktree, so every card paid the
 * cold 8–16 min. This module carries that file from one worktree to the next:
 *
 *   restore — before tsc, a worktree that has no build info of its own gets the newest shared one;
 *   save    — after a GREEN tsc, the worktree's build info becomes the shared one.
 *
 * Why this cannot let a type error through: the build info is only a cache. tsc hashes every
 * source file and compares it with the hash in the build info; a changed file is re-checked, and so
 * is every file that imports it (directly or through a chain) when its exported types changed —
 * that is how `tsc --incremental` and `tsc -b` work. An old, foreign or wrong build info makes tsc
 * slower, never more lenient. tests/ops/worker-tsc-cache.test.ts proves both cases with real tsc:
 * an error in a changed file, and an error that shows up only in an UNCHANGED importer.
 *
 * Paths inside the build info are relative to the worktree's production/ folder (node_modules via
 * the junction resolves to ../../new-reselleros/production/node_modules), so every worktree at
 * <home>/reselleros-w-<card> reads it the same way. A worktree somewhere else still gets a correct
 * (just colder) run.
 *
 * Only ever touched inside worker-lock's "heavy" turn, so two workers never read/write it at once;
 * the write is still tmp + rename so a crash cannot leave half a file.
 *
 * `--full-tsc` (worker-lock tsc / push) skips all of this and runs the old full check with
 * `--incremental false` — no build info read or written.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const TSC_CACHE_DIR = process.env.WORKER_TSC_CACHE_DIR || path.join(os.homedir(), ".claude", "worker-tsc-cache");
export const BUILD_INFO = "tsconfig.tsbuildinfo";

/** The old, always-cold check (pre-R-1960), kept for `--full-tsc`. */
export const TSC_FULL_STEP = "npx tsc --noEmit -p . --incremental false";

function typescriptVersion(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, "node_modules", "typescript", "package.json"), "utf8")).version; }
  catch { return "unknown"; }
}

/**
 * One shared file per TypeScript version + tsconfig.json. tsc itself ignores a build info written by
 * another TS version or other compiler options, so keying on them only avoids a useless copy.
 */
export function cacheKey(root) {
  let cfg = "";
  try { cfg = fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"); } catch {}
  return crypto.createHash("sha256").update(`${typescriptVersion(root)}\n${cfg}`).digest("hex").slice(0, 12);
}

export function cacheFile(root, dir = TSC_CACHE_DIR) {
  return path.join(dir, `tsc-${cacheKey(root)}.tsbuildinfo`);
}

/**
 * Before tsc. The worktree's own build info (an earlier run on this card) is closer to its code than
 * the shared one, so it is kept. Returns what happened, for the gate's log line.
 */
export function restoreBuildInfo(root, { dir = TSC_CACHE_DIR } = {}) {
  const own = path.join(root, BUILD_INFO);
  if (fs.existsSync(own)) return { restored: false, reason: "own" };
  const src = cacheFile(root, dir);
  if (!fs.existsSync(src)) return { restored: false, reason: "empty" };
  try { fs.copyFileSync(src, own); return { restored: true, reason: "shared", from: src }; }
  catch (e) { return { restored: false, reason: `copy failed: ${e.message}` }; }
}

/** After a green tsc: this worktree's build info becomes the shared one (atomic replace). */
export function saveBuildInfo(root, { dir = TSC_CACHE_DIR } = {}) {
  const own = path.join(root, BUILD_INFO);
  if (!fs.existsSync(own)) return { saved: false, reason: "no build info written" };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const dest = cacheFile(root, dir);
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.copyFileSync(own, tmp);
    fs.renameSync(tmp, dest);
    return { saved: true, to: dest };
  } catch (e) { return { saved: false, reason: e.message }; }
}

/** Drop the worktree's build info (full mode), so nothing stale survives a --full-tsc run either. */
export function dropBuildInfo(root) {
  fs.rmSync(path.join(root, BUILD_INFO), { force: true });
}

export function parseTscFlags(args) {
  return { full: args.includes("--full-tsc") || args.includes("--full") };
}
