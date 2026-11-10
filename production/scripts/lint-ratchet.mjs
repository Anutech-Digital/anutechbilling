/**
 * ESLint ratchet — warnings may go DOWN, never UP.
 *
 *   node scripts/lint-ratchet.mjs            (or: npm run lint:ratchet)   check
 *   node scripts/lint-ratchet.mjs --update                                 lower the baseline
 *   node scripts/lint-ratchet.mjs --cache    the same check, linting only files it has not seen
 *                                            (R-2568 — `worker-lock push` runs this; see below)
 *
 * Why: `next lint` exits 0 on warnings, so a rule set to "warn" never stops anything, and
 * flipping `no-explicit-any` / `max-lines` straight to "error" would turn CI red on code
 * nobody is touching today (S18, Sep 2026). So each rule's CURRENT warning count is written
 * down in lint-baseline.json and CI fails if any rule goes above its number. Fix some, run
 * `--update`, commit the smaller numbers — the ceiling only ever moves down.
 *
 * Any ESLint ERROR fails outright; errors are not baselined.
 * `--update` refuses to RAISE a number: a rule that grew must be fixed, or the baseline
 * edited by hand in a reviewed commit that says why.
 *
 * --cache (R-2568, 7 Nov 2026): twice on 7 Nov a push went red in CI only here (R-2558 max-lines
 * 26/25, R-2566 exhaustive-deps 12/10), so `worker-lock push` runs it. A full run is 2–4 min on this
 * laptop under load, and ESLint's own --cache still reads all ~4,900 files each time (25–150 s
 * measured). This mode keeps, per file, the warning counts + error lines keyed by
 *   (path, git blob sha, config key)   — config key = .eslintrc.json + package-lock.json + this file
 * in one cache shared by every checkout (<tmp>/reselleros-lint-cache). The files and blob shas come
 * from `git ls-tree HEAD` (what CI checks out — no file is opened); a file whose working copy differs
 * from HEAD, and an untracked one, is always linted from disk and never cached. The rules in use are per-file (not type-aware — see ci.yml),
 * so the same path + same bytes + same config gives the same messages: the totals equal a full run's
 * (checked against a full run on 7 Nov: identical output; tests/worker-lock-lint.test.ts covers the
 * cache rules). A ratchet RED on push is the same red CI would show. Files: what git tracks under src/ —
 * what CI checks out — minus .eslintrc ignores. CI still runs the full check on every push.
 */
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(ROOT, "lint-baseline.json");
export const LINT_CACHE_FILE = join(tmpdir(), "reselleros-lint-cache", "per-file-v1.json");
const LINT_FILE = /^src\/(?!(?:[^]*\/)?\.)[^]*\.(js|jsx|ts|tsx)$/; // the glob below; dot names skipped like a glob

/** The CI check on per-rule warning counts. Pure: { lines (stdout), errLines (stderr), over, code }. */
export function ratchetVerdict(counts, base, errors = 0) {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  const lines = [];
  const errLines = [];
  const over = [];
  for (const [rule, n] of Object.entries(sorted)) {
    const max = base[rule] ?? 0; // a rule not in the baseline has a ceiling of 0
    const mark = n > max ? "OVER" : n < max ? "below (run --update)" : "ok";
    lines.push(`${String(n).padStart(4)} / ${String(max).padEnd(4)} ${rule}  ${mark}`);
    if (n > max) over.push(rule);
  }
  if (errors) errLines.push(`\n${errors} ESLint error(s) — errors are never baselined.`);
  if (over.length) {
    errLines.push(`\nLint ratchet FAILED — more warnings than baseline for: ${over.join(", ")}`);
    errLines.push("Fix the new ones (run `npx next lint` to see where). Do not raise lint-baseline.json to pass.");
  }
  return { lines, errLines, over, code: errors || over.length ? 1 : 0 };
}

/** One file's ESLint messages → { w: {rule: warnings}, e: [error lines] } (what the totals need). */
export function summarize(relPath, messages) {
  const w = {};
  const e = [];
  for (const m of messages) {
    if (m.severity === 2) { e.push(`ERROR ${relPath}:${m.line}  ${m.ruleId ?? "(parse)"}  ${m.message}`); continue; }
    const k = m.ruleId ?? "(no-rule)";
    w[k] = (w[k] ?? 0) + 1;
  }
  return { w, e };
}

/** Add up per-file summaries → { counts, errorLines }. */
export function total(summaries) {
  const counts = {};
  const errorLines = [];
  for (const s of summaries) {
    for (const [k, n] of Object.entries(s.w)) counts[k] = (counts[k] ?? 0) + n;
    errorLines.push(...s.e);
  }
  return { counts, errorLines };
}

const gitIn = (root) => (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 << 20 });

/**
 * Everything that can change a file's ESLint result besides its own path + bytes: every ESLint config
 * file in the tree (root .eslintrc.json, any nested .eslintrc.* / eslint.config.*), package.json
 * (an `eslintConfig` field), the lockfile, this script, and the INSTALLED versions ESLint actually
 * loads (eslint, the next config, react — eslint-plugin-react "detect" reads it). Different key →
 * different cache entries (never a shared one), so a changed config re-lints instead of reusing.
 */
export function configKey(root = ROOT, git = gitIn(root)) {
  const h = createHash("sha1");
  const cfg = git(["ls-files", "-z", "--", "package.json", "package-lock.json", "scripts/lint-ratchet.mjs", ":(glob)**/.eslintrc*", ":(glob)**/eslint.config.*"])
    .split("\0").filter(Boolean).sort();
  for (const f of cfg) {
    h.update(f).update("\0");
    try { h.update(readFileSync(join(root, f))); } catch { h.update("(missing)"); }
  }
  const require = createRequire(join(root, "package.json"));
  for (const p of ["eslint", "eslint-config-next", "react", "@typescript-eslint/eslint-plugin", "eslint-plugin-react-hooks"]) {
    let v = "(none)";
    try { v = require(`${p}/package.json`).version; } catch { /* not installed */ }
    h.update(`${p}@${v}\0`);
  }
  return h.digest("hex");
}

/**
 * What a full run would lint, from git: HEAD's src/ lint files with their blob sha (what CI checks
 * out), PLUS untracked src/ files (a full local run lints them too; they get blob null). `dirty` = files
 * whose working copy is not HEAD's (edited, staged, untracked) — always linted from disk, never cached.
 * A HEAD file missing from disk (deleted, not committed) throws: commit the deletion first.
 */
export function trackedLintFiles(root = ROOT, git = gitIn(root), exists = (p) => existsSync(join(root, p))) {
  const files = [];
  for (const rec of git(["ls-tree", "-r", "-z", "HEAD", "--", "src"]).split("\0")) {
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const p = rec.slice(tab + 1);
    const [, type, blob] = rec.slice(0, tab).split(" ");
    if (type === "blob" && LINT_FILE.test(p)) files.push({ path: p, blob });
  }
  const dirty = new Set(git(["diff", "--name-only", "--relative", "-z", "HEAD", "--", "src"]).split("\0").filter(Boolean));
  for (const p of git(["ls-files", "--others", "--exclude-standard", "-z", "--", "src"]).split("\0").filter(Boolean)) {
    if (LINT_FILE.test(p)) { files.push({ path: p, blob: null }); dirty.add(p); }
  }
  const gone = files.filter((f) => dirty.has(f.path) && !exists(f.path)).map((f) => f.path);
  if (gone.length) throw new Error(`lint-ratchet --cache: deleted but not committed — commit it first: ${gone.slice(0, 5).join(", ")}`);
  return { files, dirty };
}

function readCache(file) {
  try { const c = JSON.parse(readFileSync(file, "utf8")); return c && typeof c.entries === "object" ? c : null; } catch { return null; }
}
const relOf = (root, abs) => {
  const rel = relative(resolve(root), resolve(abs)).split("\\").join("/");
  return process.platform === "win32" ? rel.toLowerCase() : rel;
};

/**
 * The --cache run. `lint(paths)` → ESLint results for those absolute paths; `ignored(path)` → whether
 * .eslintrc ignores it. Cache entry key = config key + path + blob. Returns { counts, errorLines, linted, cached }.
 */
export async function cachedCounts({ root = ROOT, cacheFile = LINT_CACHE_FILE, lint, ignored, tracked = trackedLintFiles(root), key = configKey(root) }) {
  const entries = readCache(cacheFile)?.entries ?? {};
  const flags = await Promise.all(tracked.files.map((f) => ignored(f.path)));
  const want = tracked.files.filter((_, i) => !flags[i]);
  const keyOf = (f) => `${key}\0${f.path}\0${f.blob}`;
  const clean = (f) => !tracked.dirty.has(f.path) && f.blob;
  const fresh = want.filter((f) => !clean(f) || !entries[keyOf(f)]);
  const byPath = new Map();
  if (fresh.length) {
    for (const r of await lint(fresh.map((f) => join(root, f.path)))) {
      const shown = relative(resolve(root), resolve(r.filePath)).split("\\").join("/");
      byPath.set(relOf(root, r.filePath), summarize(shown, r.messages));
    }
  }
  const used = {};
  const sums = [];
  for (const f of want) {
    const s = byPath.get(relOf(root, join(root, f.path))) ?? (clean(f) ? entries[keyOf(f)] : undefined);
    if (!s) throw new Error(`lint-ratchet --cache: no result for ${f.path}`); // never count a file as clean by accident
    sums.push(s);
    if (clean(f)) used[keyOf(f)] = s;
  }
  if (fresh.some(clean)) {
    try { // merge with what other checkouts wrote meanwhile (other config keys stay); cap the size
      const keep = readCache(cacheFile)?.entries ?? {};
      const merged = Object.keys(keep).length > 30000 ? { ...used } : { ...keep, ...used };
      mkdirSync(dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify({ entries: merged }));
      renameSync(tmp, cacheFile);
    } catch { /* the cache is only for speed */ }
  }
  return { ...total(sums), linted: fresh.length, cached: want.length - fresh.length };
}

async function main(argv) {
  const require = createRequire(join(ROOT, "package.json"));
  const { ESLint } = require("eslint");
  // Same directories `next lint` walks by default; only src/ exists in this app.
  const eslint = new ESLint({ cwd: ROOT });
  let counts, errorLines;
  if (argv.includes("--cache") && !argv.includes("--update")) {
    const t0 = Date.now();
    const r = await cachedCounts({ lint: (paths) => eslint.lintFiles(paths), ignored: (p) => eslint.isPathIgnored(join(ROOT, p)) });
    ({ counts, errorLines } = r);
    console.log(`(lint-ratchet --cache: ${r.linted} file(s) linted, ${r.cached} from cache, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } else {
    const results = await eslint.lintFiles(["src/**/*.{js,jsx,ts,tsx}"]);
    ({ counts, errorLines } = total(results.map((r) => { const rel = relative(resolve(ROOT), resolve(r.filePath)).split("\\").join("/"); return summarize(rel, r.messages); })));
  }
  for (const l of errorLines) console.error(l);
  const errors = errorLines.length;
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  const base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")).maxWarnings ?? {} : {};

  if (argv.includes("--update")) {
    const next = {};
    const grew = [];
    for (const [rule, n] of Object.entries(sorted)) {
      if (rule in base && n > base[rule]) grew.push(`${rule}: ${base[rule]} -> ${n}`);
      next[rule] = rule in base ? Math.min(n, base[rule]) : n;
    }
    for (const rule of Object.keys(base)) if (!(rule in next)) next[rule] = 0;
    writeFileSync(BASELINE, JSON.stringify({
      _note: "Max ESLint WARNINGS per rule. CI fails above these. Lower only: node scripts/lint-ratchet.mjs --update",
      maxWarnings: next,
    }, null, 2) + "\n");
    console.log("baseline written:", next);
    if (grew.length) console.error("NOT raised (fix these first):\n  " + grew.join("\n  "));
    return grew.length || errors ? 1 : 0;
  }

  const v = ratchetVerdict(counts, base, errors);
  for (const l of v.lines) console.log(l);
  for (const l of v.errLines) console.error(l);
  return v.code;
}

/* Real paths on both sides: Node resolves a junction/symlink in import.meta.url but not in argv[1]. */
const real = (p) => { try { return realpathSync(p).toLowerCase(); } catch { return resolve(p).toLowerCase(); } };
if (process.argv[1] && real(fileURLToPath(import.meta.url)) === real(process.argv[1])) {
  process.exit(await main(process.argv.slice(2)));
}
