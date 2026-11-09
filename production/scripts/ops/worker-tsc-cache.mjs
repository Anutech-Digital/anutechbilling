/**
 * R-1960 (26 Oct 2026): a shared tsc build-info cache for worker worktrees.
 *
 * Measured on the real repo (laptop, 26 Oct): a fresh worktree's `tsc --noEmit` took 525 s; the
 * SAME worktree's second run took 78 s, because tsconfig.json already has `incremental: true` and
 * tsc reuses `tsconfig.tsbuildinfo`. Every card started in a NEW worktree, so every card paid the
 * cold 8–16 min. This module carries that file from one worktree to the next:
 *
 *   restore — after `next typegen`, before tsc: a worktree with no build info of its own gets the
 *             shared one for the SAME route types (cache key, below);
 *   save    — after a GREEN tsc, the worktree's build info becomes the shared one for that key.
 *
 * Why the key includes the route types: `next typegen` writes .next/types/routes.d.ts and link.d.ts,
 * which are GLOBAL declarations (the typed-routes Route union). When a global file changes, tsc must
 * re-check every file — measured: a build info from a base 10 commits older with one route fewer
 * gave a 704 s run, no faster than cold. So a build info is only reused when the route types are
 * byte-identical; ~7% of manager-pardeep commits add or remove a route (26 of 374 since 19 Oct), so
 * after such a commit the first worker runs cold once and fills the cache for the next ones.
 *
 * Why this cannot let a type error through: the build info is only a cache. tsc hashes every
 * source file and compares it with the hash in the build info; a changed file is re-checked, and so
 * is every file that imports it (directly or through a chain) when its exported types changed —
 * that is how `tsc --incremental` and `tsc -b` work. An old, foreign or wrong build info makes tsc
 * slower, never more lenient. tests/ops/worker-tsc-cache.test.ts proves both cases with real tsc:
 * an error in a changed file, and an error that shows up only in an UNCHANGED importer; on the real
 * repo a probe gave the identical 8 errors incremental and with --full-tsc.
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
import { createRequire } from "node:module";

export const TSC_CACHE_DIR = process.env.WORKER_TSC_CACHE_DIR || path.join(os.homedir(), ".claude", "worker-tsc-cache");
export const BUILD_INFO = "tsconfig.tsbuildinfo";
/** Shared build infos kept (one per route-types version); older ones are pruned on save. */
export const CACHE_KEEP = 8;

/** The old, always-cold check (pre-R-1960), kept for `--full-tsc`. */
export const TSC_FULL_STEP = "npx tsc --noEmit -p . --incremental false";

function typescriptVersion(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, "node_modules", "typescript", "package.json"), "utf8")).version; }
  catch { return "unknown"; }
}

/** Every file `next typegen` wrote under .next/types (sorted), as "name\ncontent" parts. */
function routeTypes(root) {
  const dir = path.join(root, ".next", "types");
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".ts")).sort(); } catch { return ""; }
  return names.map((n) => `${n}\n${fs.readFileSync(path.join(dir, n), "utf8")}`).join("\n");
}

/**
 * TypeScript version + tsconfig.json + the generated route types. tsc ignores a build info from
 * another TS version or other compiler options anyway; the route types are global, so a mismatch
 * there means a full re-check (see the header) — a different key avoids that useless copy.
 */
export function cacheKey(root) {
  let cfg = "";
  try { cfg = fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"); } catch {}
  return crypto.createHash("sha256").update(`${typescriptVersion(root)}\n${cfg}\n${routeTypes(root)}`).digest("hex").slice(0, 12);
}

export function cacheFile(root, dir = TSC_CACHE_DIR) {
  return path.join(dir, `tsc-${cacheKey(root)}.tsbuildinfo`);
}

/**
 * tsc's own file version: the same hash it stores in the build info (TypeScript's
 * getSourceFileVersionAsHashFromText = sha256 of the text, minus a trailing sourceMappingURL line).
 * Falls back to plain sha256 if this TypeScript does not expose it.
 */
function versionHasher(root) {
  try {
    const ts = createRequire(path.join(root, "package.json"))("typescript");
    if (typeof ts.getSourceFileVersionAsHashFromText === "function" && ts.sys?.createHash) {
      const host = { createHash: (s) => ts.sys.createHash(s) };
      return (text) => ts.getSourceFileVersionAsHashFromText(host, text);
    }
  } catch {}
  return (text) => crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * R-2634 (9 Nov 2026): how far a build info is from the worktree's files right now — how many of
 * its project files (outside node_modules, which every worktree shares through the junction) have
 * another text today or are gone, and whether one of them is a GLOBAL file (affectsGlobalScope,
 * e.g. .next/types/routes.d.ts): a changed global file makes tsc re-check EVERY file.
 * null = unreadable (tsc would ignore it and run cold).
 */
export function buildInfoDistance(root, file, hash = versionHasher(root)) {
  let info;
  try { info = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  if (!Array.isArray(info?.fileNames) || !Array.isArray(info?.fileInfos)) return null;
  let changed = 0, global = 0, project = 0;
  info.fileNames.forEach((name, i) => {
    if (/(^|\/)node_modules\//.test(name)) return;
    project++;
    const fi = info.fileInfos[i];
    const version = typeof fi === "string" ? fi : fi?.version;
    let text = null;
    try { text = fs.readFileSync(path.resolve(root, name), "utf8"); } catch {}
    if (text !== null && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (text !== null && hash(text) === version) return;
    changed++;
    if (typeof fi === "object" && fi?.affectsGlobalScope) global++;
  });
  return { changed, global, project };
}

/** Lower = less for tsc to re-check. A changed global file means a full re-check. */
function distanceScore(d) {
  if (!d) return Number.POSITIVE_INFINITY;
  return d.global ? 1e9 + d.changed : d.changed;
}

/**
 * After typegen, before tsc. R-1960 kept the worktree's own build info whenever it had one; R-2634
 * found that wrong exactly where it costs most — inside `push`, after the rebase: the own build info
 * is from the card's OLD base (everything merged since then counts as changed, and a route added
 * since then is a global change = full re-check, 445–1063 s measured 9 Nov), while the shared one for
 * the same route types was saved by the last push on the NEW base. Now both are measured against
 * the files on disk (buildInfoDistance) and the closer one is used; a tie keeps the own one.
 * Either choice is only a starting point — tsc still hashes every file and re-checks what changed.
 */
export function restoreBuildInfo(root, { dir = TSC_CACHE_DIR, hash } = {}) {
  const own = path.join(root, BUILD_INFO);
  const src = cacheFile(root, dir);
  const hasOwn = fs.existsSync(own), hasShared = fs.existsSync(src);
  if (!hasShared) return hasOwn ? { restored: false, reason: "own" } : { restored: false, reason: "empty" };
  let ownDist = null, sharedDist = null;
  if (hasOwn) {
    const h = hash ?? versionHasher(root);
    ownDist = buildInfoDistance(root, own, h);
    sharedDist = buildInfoDistance(root, src, h);
    if (distanceScore(ownDist) <= distanceScore(sharedDist)) return { restored: false, reason: "own", own: ownDist, shared: sharedDist };
  }
  try { fs.copyFileSync(src, own); return { restored: true, reason: "shared", from: src, ...(hasOwn ? { own: ownDist, shared: sharedDist } : {}) }; }
  catch (e) { return { restored: false, reason: `copy failed: ${e.message}` }; }
}

/** One line for the gate's log: which build info tsc starts from and how far it is. */
export function restoreLine(r) {
  const d = (x) => (x ? `${x.changed} file badli${x.global ? `, ${x.global} global — poora re-check` : ""}` : "padhi nahi gayi");
  const both = r.own !== undefined || r.shared !== undefined ? ` [apni: ${d(r.own)}; shared: ${d(r.shared)}]` : "";
  if (r.restored) return `  tsc: incremental — shared cache se shuru (${r.from})${both}`;
  if (r.reason === "own") return `  tsc: incremental — is worktree ki apni build info${both}`;
  return `  tsc: incremental — in route types ka shared cache nahi (${r.reason}), is baar poora chalega`;
}

/** After a green tsc: this worktree's build info becomes the shared one for its key (atomic replace). */
export function saveBuildInfo(root, { dir = TSC_CACHE_DIR, keep = CACHE_KEEP } = {}) {
  const own = path.join(root, BUILD_INFO);
  if (!fs.existsSync(own)) return { saved: false, reason: "no build info written" };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const dest = cacheFile(root, dir);
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.copyFileSync(own, tmp);
    fs.renameSync(tmp, dest);
    pruneCache(dir, keep);
    return { saved: true, to: dest };
  } catch (e) { return { saved: false, reason: e.message }; }
}

/** Keep only the `keep` newest shared build infos. */
export function pruneCache(dir = TSC_CACHE_DIR, keep = CACHE_KEEP) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((n) => /^tsc-[0-9a-f]+\.tsbuildinfo$/.test(n)); } catch { return; }
  files.map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t).slice(keep)
    .forEach(({ n }) => fs.rmSync(path.join(dir, n), { force: true }));
}

/** Drop the worktree's build info (full mode), so nothing stale survives a --full-tsc run either. */
export function dropBuildInfo(root) {
  fs.rmSync(path.join(root, BUILD_INFO), { force: true });
}

export function parseTscFlags(args) {
  return { full: args.includes("--full-tsc") || args.includes("--full") };
}
