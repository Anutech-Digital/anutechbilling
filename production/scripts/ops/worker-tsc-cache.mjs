/**
 * R-1960 (26 Oct 2026): a shared tsc build-info cache for worker worktrees.
 *
 * Measured on the real repo (laptop, 26 Oct): a fresh worktree's `tsc --noEmit` took 525 s; the
 * SAME worktree's second run took 78 s, because tsconfig.json already has `incremental: true` and
 * tsc reuses `tsconfig.tsbuildinfo`. Every card started in a NEW worktree, so every card paid the
 * cold 8–16 min. This module carries that file from one worktree to the next:
 *
 *   restore — after `next typegen`, before tsc: the worktree starts from the shared build info for
 *             the SAME route types (cache key, below) — when it has its own build info too, from
 *             whichever of the two is closer to its files (R-2634, see restoreBuildInfo);
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
 * R-2718 (12 Nov 2026): where this worktree's node_modules really is, relative to its production/
 * folder ("../../reselleros-deploy/production/node_modules"), "" when there is none. tsc follows the
 * junction to its real path, so EVERY node_modules file name in the build info carries this prefix.
 * Two worktrees whose junctions point at different clones (WORKER-SESSION-PROMPT said new-reselleros,
 * WORKER-STEPS said reselleros-deploy) see each other's 2,300 node_modules files — 122 of them global
 * (@types/node, react) — as NEW, so tsc re-checks everything (12 Nov: 1377–2488 s pushes while the
 * restore line said "5 file badli"). And each saved over the other's cache under the same key.
 */
export function nodeModulesTarget(root) {
  try { return path.relative(root, fs.realpathSync(path.join(root, "node_modules"))).replace(/\\/g, "/"); }
  catch { return ""; }
}

/** The default lib folder (lib.es2022.d.ts …) of the TypeScript this worktree runs, relative like the build info. */
function typescriptLibDir(root) {
  for (const from of [path.join(root, "package.json"), import.meta.url]) {
    try { return path.relative(root, fs.realpathSync(path.dirname(createRequire(from).resolve("typescript/lib/lib.d.ts")))).replace(/\\/g, "/"); }
    catch {}
  }
  return "";
}

/**
 * TypeScript version + tsconfig.json + the generated route types (+ R-2718: the node_modules real
 * path when it is not the worktree's own folder). tsc ignores a build info from another TS version or
 * other compiler options anyway; the route types are global, so a mismatch there means a full
 * re-check (see the header) — a different key avoids that useless copy. Same for a build info written
 * through a junction to another clone. A plain node_modules folder ("node_modules") keeps the old key.
 */
export function cacheKey(root, { legacy = false } = {}) {
  let cfg = "";
  try { cfg = fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"); } catch {}
  const nm = legacy ? "" : nodeModulesTarget(root);
  const extra = nm && nm !== "node_modules" ? `\nnode_modules=${nm}` : "";
  return crypto.createHash("sha256").update(`${typescriptVersion(root)}\n${cfg}\n${routeTypes(root)}${extra}`).digest("hex").slice(0, 12);
}

export function cacheFile(root, dir = TSC_CACHE_DIR, { legacy = false } = {}) {
  return path.join(dir, `tsc-${cacheKey(root, { legacy })}.tsbuildinfo`);
}

/**
 * tsc's own file version: the same hash it stores in the build info (TypeScript's
 * getSourceFileVersionAsHashFromText = sha256 of the text, minus a trailing sourceMappingURL line).
 * Falls back to plain sha256 if this TypeScript does not expose it.
 */
function versionHasher(root) {
  /* The worktree's TypeScript first; else the one next to this script (same repo, via the junction). */
  for (const from of [path.join(root, "package.json"), import.meta.url]) {
    try {
      const ts = createRequire(from)("typescript");
      if (typeof ts.getSourceFileVersionAsHashFromText === "function" && ts.sys?.createHash) {
        const host = { createHash: (x) => ts.sys.createHash(x) };
        return Object.assign((text) => ts.getSourceFileVersionAsHashFromText(host, text), { kind: "typescript" });
      }
    } catch {}
  }
  return Object.assign((text) => crypto.createHash("sha256").update(text).digest("hex"), { kind: "sha256" });
}

/** Which hash restore uses: "typescript" (tsc's own) or "sha256" (fallback — the log line says so). */
export function hasherKind(root) { return versionHasher(root).kind; }

const isProjectFile = (name) => !/(^|\/)node_modules\//.test(name);

function readBuildInfo(file) {
  let info;
  try { info = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  return Array.isArray(info?.fileNames) && Array.isArray(info?.fileInfos) ? info : null;
}

/** Hash of each file on disk, read once per restore (null = gone); shared by both measurements. */
function diskHashes(root, hash) {
  const seen = new Map();
  return (name) => {
    if (!seen.has(name)) {
      let text = null;
      try { text = fs.readFileSync(path.resolve(root, name), "utf8"); } catch {}
      if (text !== null && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      seen.set(name, text === null ? null : hash(text));
    }
    return seen.get(name);
  };
}

/**
 * R-2634 (9 Nov 2026): how far a build info is from the worktree's files right now.
 *   changed — its project files (outside node_modules, which every worktree shares through the
 *             junction) whose text differs today or that are gone, plus `alsoOnDisk` files (seen in
 *             the other candidate) that exist on disk but this build info has never checked;
 *   global  — how many of those are GLOBAL (affectsGlobalScope, e.g. .next/types/routes.d.ts): a
 *             changed global file makes tsc re-check EVERY file;
 *   weight  — each changed file counted with its direct importers (referencedMap), because tsc
 *             re-checks the importers of a file whose exported types changed (a hub like ist.ts
 *             costs far more than a leaf).
 * R-2718 (12 Nov 2026): node_modules files count too (~1.2 s more for ~2,300 files / 21 MB):
 *   foreign — node_modules files under ANOTHER real path than this worktree's (`nm`, see
 *             nodeModulesTarget): tsc sees them all as new — flagged as a global change (full re-check);
 *   modules — node_modules files of the same path whose text changed (e.g. after `npm ci`); a changed
 *             global one (@types/node) is a global change as well.
 * Before R-2718 both were invisible here: the restore line said "5 file badli" for a 1377 s run.
 * null = unreadable (tsc would ignore it and run cold).
 */
export function buildInfoDistance(root, file, { hash = versionHasher(root), disk = diskHashes(root, hash), alsoOnDisk = [], nm = nodeModulesTarget(root), tsLib = typescriptLibDir(root) } = {}) {
  const info = readBuildInfo(file);
  if (!info) return null;
  /* referencedMap: [fileId, fileIdsList index] pairs, both 1-based — file → the files it imports. */
  const importers = new Map();
  for (const [, list] of Array.isArray(info.referencedMap) ? info.referencedMap : []) {
    for (const ref of info.fileIdsList?.[list - 1] ?? []) importers.set(ref, (importers.get(ref) ?? 0) + 1);
  }
  let changed = 0, global = 0, project = 0, weight = 0, foreign = 0, modules = 0;
  const known = new Set();
  info.fileNames.forEach((name, i) => {
    const fi = info.fileInfos[i];
    const isGlobal = typeof fi === "object" && !!fi?.affectsGlobalScope;
    if (!isProjectFile(name)) {
      /* tsc's default libs come from the TypeScript that runs (normally inside the same node_modules) */
      if (nm && !name.startsWith(`${nm}/`) && !(tsLib && name.startsWith(`${tsLib}/`))) { foreign++; return; }
      const version = typeof fi === "string" ? fi : fi?.version;
      if (disk(name) === version) return;
      modules++; weight += 1 + (importers.get(i + 1) ?? 0);
      if (isGlobal) global++;
      return;
    }
    project++; known.add(name);
    const version = typeof fi === "string" ? fi : fi?.version;
    if (disk(name) === version) return;
    changed++; weight += 1 + (importers.get(i + 1) ?? 0);
    if (isGlobal) global++;
  });
  for (const name of alsoOnDisk) {
    if (known.has(name) || disk(name) === null) continue;
    changed++; weight++;
  }
  if (foreign) global++;
  return { changed, global, project, weight, foreign, modules };
}

/** Lower = less for tsc to re-check. A changed global file means a full re-check. */
function distanceScore(d) {
  if (!d) return Number.POSITIVE_INFINITY;
  return d.global ? 1e9 + d.weight : d.weight;
}

/**
 * After typegen, before tsc. R-1960 kept the worktree's own build info whenever it had one; R-2634
 * found that wrong exactly where it costs most — inside `push`, after the rebase: the own build info
 * is from the card's OLD base (everything merged since then counts as changed, and a route added
 * since then is a global change = full re-check; 445–1063 s seen 9 Nov, 1181.7 s measured), while the
 * shared one for the same route types was saved by the last push on the NEW base (62.7 s). Now both
 * are measured against the files on disk (buildInfoDistance, one read + hash per file) and the
 * closer one is used; a tie keeps the own one. Either choice is only a starting point — tsc still
 * hashes every file and re-checks what changed, so a wrong pick is slower, never more lenient.
 */
export function restoreBuildInfo(root, { dir = TSC_CACHE_DIR, hash, nm } = {}) {
  const own = path.join(root, BUILD_INFO);
  /* R-2718: the key now carries the node_modules real path. The shared file saved under the OLD key
     (before R-2718) is still used — but only after measuring shows it was written through the same
     node_modules (no foreign files); so the first push after R-2718 does not run cold. */
  const fresh = cacheFile(root, dir), legacy = cacheFile(root, dir, { legacy: true });
  const src = fs.existsSync(fresh) ? fresh : legacy !== fresh && fs.existsSync(legacy) ? legacy : null;
  const hasOwn = fs.existsSync(own);
  if (!src) return hasOwn ? { restored: false, reason: "own" } : { restored: false, reason: "empty" };
  const viaLegacy = src !== fresh;
  let measured = {};
  if (hasOwn || viaLegacy) {
    const h = hash ?? versionHasher(root);
    const disk = diskHashes(root, h);
    const mods = nm ?? nodeModulesTarget(root);
    const names = (file) => (readBuildInfo(file)?.fileNames ?? []).filter(isProjectFile);
    measured = {
      ...(hasOwn ? { own: buildInfoDistance(root, own, { hash: h, disk, nm: mods, alsoOnDisk: names(src) }) } : {}),
      shared: buildInfoDistance(root, src, { hash: h, disk, nm: mods, alsoOnDisk: hasOwn ? names(own) : [] }),
      hashKind: h.kind ?? "custom",
      ...(viaLegacy ? { legacy: true } : {}),
    };
    /* A pre-R-2718 file written through another clone's node_modules is no better than nothing. */
    if (viaLegacy && (!measured.shared || measured.shared.foreign)) {
      return hasOwn ? { restored: false, reason: "own", ...measured } : { restored: false, reason: "empty", ...measured };
    }
    if (hasOwn && distanceScore(measured.own) <= distanceScore(measured.shared)) return { restored: false, reason: "own", ...measured };
  }
  try { fs.copyFileSync(src, own); return { restored: true, reason: "shared", from: src, ...measured }; }
  catch (e) { return { restored: false, reason: hasOwn ? "own" : `copy failed: ${e.message}`, copyFailed: e.message, ...measured }; }
}

/** One line for the gate's log: which build info tsc starts from and how far it is. */
export function restoreLine(r) {
  const d = (x) => (x
    ? `${x.changed} file badli${x.modules ? `, ${x.modules} node_modules file badli` : ""}${x.foreign ? `, ${x.foreign} node_modules file doosre clone ke junction se` : ""}${x.global ? `, ${x.global} global — poora re-check` : ""}`
    : "padhi nahi gayi");
  const warn = r.hashKind === "sha256" ? "; DHYAN: tsc ka hash nahi mila, ginti galat ho sakti hai" : "";
  const both = r.own !== undefined || r.shared !== undefined ? ` [apni: ${d(r.own)}; shared: ${d(r.shared)}${warn}]` : "";
  if (r.restored) return `  tsc: incremental — shared cache se shuru (${r.from}${r.legacy ? ", R-2718 se pehle wali key" : ""})${both}`;
  if (r.legacy && r.reason === "empty") return `  tsc: incremental — purani shared cache doosre clone ke node_modules se bani thi, kaam ki nahi; is baar poora chalega${both}`;
  if (r.reason === "own") return `  tsc: incremental — is worktree ki apni build info${r.copyFailed ? ` (shared copy nahi hui: ${r.copyFailed})` : ""}${both}`;
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
