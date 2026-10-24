/**
 * R-1594 (18 Oct 2026) — clear old agent worktrees under .claude/worktrees, SAFELY.
 *
 * 18 Oct: `git worktree list` showed 124 worktrees, 112 of them .claude/worktrees/agent-*.
 * Nobody cleaned them because the only how-to (docs/WORKER-SESSION-PROMPT.md step 9) warns —
 * rightly — that `git worktree remove --force` on a worktree whose production/node_modules is a
 * JUNCTION to the shared node_modules deletes the SHARED folder, and every session breaks.
 *
 * DRY RUN by default — prints what it would remove and why it keeps the rest. Removes only with
 * --apply. A worktree is removed only when ALL hold:
 *   - it lives under <repo>/.claude/worktrees/ (never the main checkout, never anything else)
 *     (so the tester checkout in the home folder, and every worker folder outside it, is never
 *     even looked at)
 *   - it is not the coordinator worktree (beautiful-ptolemy-*), not a --keep path, and not the
 *     worktree this script runs from
 *   - its HEAD is contained in the base (default anutech/manager-pardeep), or every commit on it
 *     has an identical patch in the base (`git cherry` — a rebased-then-pushed branch)
 *   - `git status --porcelain` is empty (no modified/staged/untracked file)
 *   - no worker-lock claim names it (~/.claude/worker-locks, or WORKER_LOCK_DIR)
 *   - git has not marked it `locked`, and it was last touched --min-age-hours ago (default 24)
 *   - the only link/junction inside it is production/node_modules (or node_modules): any other
 *     link means git's recursive delete could reach outside — that worktree is kept and named
 *
 * --apply, per worktree: lstat production/node_modules; if it is a link/junction, fs.unlinkSync
 * removes the LINK only (never recursing into it) and the target is checked to still exist;
 * then `git worktree remove <path>` WITHOUT --force (git itself refuses a dirty tree). If git
 * refuses, the junction is put back. At the end `git worktree prune` drops dead admin entries.
 * Branches are left alone (`git branch -d` them later if wanted).
 *
 *   node scripts/ops/prune-worktrees.mjs                 # dry run: list + space it would free
 *   node scripts/ops/prune-worktrees.mjs --apply         # remove (manager only, once a day)
 *   options: --base <ref>  --min-age-hours <n>  --keep <path> (repeatable)  --no-size
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_BASE = "anutech/manager-pardeep";
export const PROTECTED_NAME = /^beautiful-ptolemy-/i;
/** Links allowed inside a worktree — the shared node_modules junction. Relative, "/"-separated. */
export const KNOWN_LINKS = ["production/node_modules", "node_modules"];

/** Comparable form of a path: resolved, forward slashes, no trailing slash, lower case on Windows. */
export function normPath(p) {
  let s = path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  if (process.platform === "win32") s = s.toLowerCase();
  return s;
}

function inside(child, parent) {
  const c = normPath(child), p = normPath(parent);
  return c === p || c.startsWith(p + "/");
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** `git worktree list --porcelain` → [{ path, head, branch, locked, bare }]. */
export function parseWorktreeList(text) {
  const out = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith("worktree ")) { cur = { path: line.slice(9), head: "", branch: null, locked: false, bare: false }; out.push(cur); continue; }
    if (!cur) continue;
    if (line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "locked" || line.startsWith("locked ")) cur.locked = true;
    else if (line === "bare") cur.bare = true;
  }
  return out;
}

/** Worktree paths named by live worker-lock files. Read-only (unlike worker-lock's readLocks). */
export function lockedWorktrees(lockDir) {
  if (!lockDir || !fs.existsSync(lockDir)) return [];
  const out = [];
  for (const f of fs.readdirSync(lockDir)) {
    if (!f.endsWith(".json") || f.startsWith("_")) continue;
    try {
      const l = JSON.parse(fs.readFileSync(path.join(lockDir, f), "utf8"));
      if (l.worktree) out.push({ card: l.card ?? f.replace(/\.json$/, ""), worktree: l.worktree });
    } catch { /* unreadable lock: ignore, worker-lock does the same */ }
  }
  return out;
}

/** Is HEAD in base, or does every commit on it have the same patch in base? */
export function mergedInto(repo, head, base) {
  try { git(repo, ["merge-base", "--is-ancestor", head, base]); return "contained"; } catch { /* not an ancestor */ }
  try {
    const lines = git(repo, ["cherry", base, head]).split(/\r?\n/).filter(Boolean);
    if (lines.length && lines.every((l) => l.startsWith("-"))) return "same-patches";
  } catch { /* unknown commit etc. */ }
  return null;
}

/**
 * Walks a worktree WITHOUT following any link/junction: bytes of real files, and every link
 * found (relative paths). lstat on every directory before descending, so a junction is never
 * entered even if readdir mis-types it.
 */
export function scanTree(root, { size = true } = {}) {
  let bytes = 0;
  const links = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(abs, e.name);
      let st;
      try { st = fs.lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink() || e.isSymbolicLink()) { links.push(r); continue; }
      if (st.isDirectory()) { if (r !== ".git") stack.push(r); continue; }
      if (size) bytes += st.size;
    }
  }
  return { bytes, links };
}

/**
 * Last real activity: the worktree's reflog (logs/HEAD — written on checkout/commit/reset) or
 * HEAD file. NOT the index: `git status` (which this script runs) rewrites the index, so every
 * worktree would look "touched just now" after one dry run.
 */
function lastTouched(wt) {
  let t = 0;
  for (const p of ["logs/HEAD", "HEAD"]) {
    try {
      const f = git(wt, ["rev-parse", "--git-path", p]).trim();
      t = Math.max(t, fs.statSync(path.resolve(wt, f)).mtimeMs);
    } catch { /* missing */ }
  }
  return t;
}

/** Decide, per worktree under <repo>/.claude/worktrees, remove or keep (with the reason). */
export function plan(opts) {
  const repo = opts.repo;
  const base = opts.base ?? DEFAULT_BASE;
  const root = opts.worktreesDir ?? path.join(repo, ".claude", "worktrees");
  const minAgeMs = (opts.minAgeHours ?? 24) * 3600_000;
  const now = opts.now ?? Date.now();
  const keep = opts.keep ?? [];
  const self = opts.self ?? process.cwd();
  const locks = lockedWorktrees(opts.lockDir);
  const all = parseWorktreeList(git(repo, ["worktree", "list", "--porcelain"]));
  const rows = [];
  for (const wt of all) {
    if (!inside(wt.path, root) || normPath(wt.path) === normPath(root)) continue;
    const name = path.basename(wt.path);
    const row = { path: wt.path, name, branch: wt.branch, head: wt.head, action: "keep", reason: "", bytes: 0, links: [] };
    rows.push(row);
    const why = (r) => { row.reason = r; };
    if (PROTECTED_NAME.test(name)) { why("coordinator worktree"); continue; }
    if (keep.some((k) => inside(wt.path, k))) { why("protected path"); continue; }
    if (inside(self, wt.path)) { why("this script runs from it"); continue; }
    if (wt.locked) { why("git worktree is locked"); continue; }
    if (!fs.existsSync(wt.path)) { why("folder missing (git worktree prune clears it)"); continue; }
    const lock = locks.find((l) => inside(l.worktree, wt.path) || inside(wt.path, l.worktree));
    if (lock) { why(`worker-lock ${lock.card}`); continue; }
    if (!wt.head) { why("no HEAD"); continue; }
    const merged = mergedInto(repo, wt.head, base);
    if (!merged) { why(`not merged into ${base}`); continue; }
    if (minAgeMs > 0 && now - lastTouched(wt.path) < minAgeMs) { why(`touched < ${opts.minAgeHours ?? 24}h ago`); continue; }
    let dirty;
    try { dirty = git(wt.path, ["status", "--porcelain"]).trim(); } catch { why("git status failed"); continue; }
    if (dirty) { why(`uncommitted changes (${dirty.split(/\r?\n/).length})`); continue; }
    const scan = scanTree(wt.path, { size: opts.size !== false });
    row.bytes = scan.bytes;
    row.links = scan.links;
    const odd = scan.links.filter((l) => !KNOWN_LINKS.includes(l));
    if (odd.length) { why(`other link/junction inside: ${odd.slice(0, 3).join(", ")}`); continue; }
    row.action = "remove";
    row.reason = merged === "contained" ? `HEAD in ${base}` : `all commits in ${base} (same patches)`;
  }
  return rows;
}

/**
 * Unlinks the junction at <wt>/<rel> — the LINK only. Returns { link, target } to restore, or
 * null when there is nothing there. Throws if it is a real folder or the target vanished.
 */
export function unlinkJunction(wt, rel) {
  const link = path.join(wt, rel);
  let st;
  try { st = fs.lstatSync(link); } catch { return null; }
  if (!st.isSymbolicLink()) throw new Error(`${link} is a real folder, not a junction — not touching it`);
  const target = fs.readlinkSync(link);
  const absTarget = path.resolve(path.dirname(link), target);
  fs.unlinkSync(link); // removes the reparse point / symlink itself; never recurses
  if (fs.existsSync(link)) throw new Error(`${link} still exists after unlink`);
  if (!fs.existsSync(absTarget)) throw new Error(`junction target ${absTarget} is GONE after unlinking ${link} — stop`);
  return { link, target };
}

function restoreJunction(j) {
  try { fs.symlinkSync(j.target, j.link, "junction"); } catch (e) { console.error(`  ! could not put back ${j.link}: ${e.message}`); }
}

/** Removes the "remove" rows. Returns { removed, failed, bytes }. */
export function apply(rows, { repo, log = console.log } = {}) {
  let bytes = 0, removed = 0;
  const failed = [];
  for (const row of rows.filter((r) => r.action === "remove")) {
    const undone = [];
    try {
      for (const rel of row.links) { const j = unlinkJunction(row.path, rel); if (j) undone.push(j); }
      git(repo, ["worktree", "remove", row.path]); // no --force, ever
      removed++;
      bytes += row.bytes;
      log(`  removed ${row.name}`);
    } catch (e) {
      for (const j of undone) if (fs.existsSync(row.path)) restoreJunction(j);
      const msg = String(e.stderr || e.message).trim().split(/\r?\n/)[0];
      failed.push({ name: row.name, error: msg });
      log(`  ! kept ${row.name}: ${msg}`);
      if (/is GONE/.test(msg)) throw e; // shared folder missing: stop everything
    }
  }
  try { git(repo, ["worktree", "prune"]); } catch { /* nothing to prune */ }
  return { removed, failed, bytes };
}

export function mb(bytes) { return `${(bytes / 1048576).toFixed(1)} MB`; }

export function parseArgs(argv) {
  const o = { apply: false, keep: [], size: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") o.apply = true;
    else if (a === "--no-size") o.size = false;
    else if (a === "--base") o.base = argv[++i];
    else if (a === "--min-age-hours") o.minAgeHours = Number(argv[++i]);
    else if (a === "--keep") o.keep.push(argv[++i]);
    else if (a === "--repo") o.repo = argv[++i];
    else throw new Error(`unknown option ${a}`);
  }
  if (o.minAgeHours !== undefined && !(o.minAgeHours >= 0)) throw new Error("--min-age-hours needs a number");
  return o;
}

/** Main checkout = first entry of `git worktree list`. */
export function mainCheckout(cwd) {
  return parseWorktreeList(git(cwd, ["worktree", "list", "--porcelain"]))[0].path;
}

export function run(opts, log = console.log) {
  const repo = opts.repo ?? mainCheckout(process.cwd());
  const lockDir = opts.lockDir ?? (process.env.WORKER_LOCK_DIR || path.join(os.homedir(), ".claude", "worker-locks"));
  const rows = plan({ ...opts, repo, lockDir });
  const rm = rows.filter((r) => r.action === "remove");
  const kept = rows.filter((r) => r.action === "keep");
  log(`${opts.apply ? "APPLY" : "DRY RUN"} — ${rows.length} worktrees under ${path.join(repo, ".claude", "worktrees")}, base ${opts.base ?? DEFAULT_BASE}`);
  for (const r of rm) log(`  REMOVE ${r.name}  [${r.branch ?? "detached"}]  ${mb(r.bytes)}  — ${r.reason}`);
  for (const r of kept) log(`  keep   ${r.name}  — ${r.reason}`);
  const byReason = {};
  for (const r of kept) { const k = r.reason.split(/[:(]/)[0].replace(/ [A-Z]-\d+$/, "").trim(); byReason[k] = (byReason[k] ?? 0) + 1; }
  log(`Summary: ${rm.length} to remove (${mb(rm.reduce((s, r) => s + r.bytes, 0))}), ${kept.length} kept: ${JSON.stringify(byReason)}`);
  if (!opts.apply) { log("Nothing removed. Run again with --apply to remove the REMOVE rows."); return { rows }; }
  const res = apply(rows, { repo, log });
  log(`Removed ${res.removed}/${rm.length}, freed ${mb(res.bytes)}${res.failed.length ? `, ${res.failed.length} kept by git` : ""}.`);
  return { rows, ...res };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { run(parseArgs(process.argv.slice(2))); } catch (e) { console.error(`prune-worktrees: ${e.message}`); process.exit(1); }
}
