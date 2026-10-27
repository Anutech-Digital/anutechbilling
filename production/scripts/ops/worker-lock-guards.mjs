/**
 * R-1958 (26 Oct 2026) — worker-lock refuses a commit/push that undoes other cards' work.
 *
 * Night 25–26 Oct, twice: a worker's `git reset --soft` onto a base that had moved produced a commit
 * whose tree was the OLD base plus the card's change — it would have reverted shipped cards (R-1915;
 * R-1952 + R-1923). Caught only by luck. `check` and `push` (before the rebase and again after it) now
 * read `git diff --name-status <merge-base> HEAD` (check: up to the working tree) and refuse — exit 9 —
 * when:
 *
 *   1. area    — an existing file OUTSIDE the card's claimed areas (the lock's `areas` from `claim`, plus
 *                the card file's `files`) is modified or deleted. Allowed: generated files (deploy-db
 *                scripts, peeks.generated.ts, database.generated.ts, docs/API.md), test files next to
 *                claimed code (same name stem) and any NEW test file. A NEW non-test file outside the
 *                claim only warns (it cannot undo anyone's work — claim it). No claimed areas known
 *                (no lock) → warn only, the old behaviour.
 *   2. migration — an existing supabase/migrations/*.sql or prisma/migrations/** file is modified,
 *                deleted or renamed. New migrations are fine.
 *   3. revert  — a changed file is back to the exact version from before another card's commit of the
 *                last 7 days, or the diff deletes at least half (and at least 3) of the lines another
 *                card's commit added in the last 7 days AND brings back what that commit removed (a
 *                commit that only added: 80% of its lines deleted). Checked on 80 real manager-pardeep
 *                commits: a plain refactor of another card's lines (R-1952 over R-1915) passes.
 *                The card's OWN earlier migration (e.g. a re-stamp) only warns under rule 2.
 *                RESTORE (R-1964): undoing a commit Y is allowed (a note, not exit 9) when the file comes
 *                back to exactly Y's parent version AND Y itself had put the file back to the version from
 *                before an older other-card commit X (Y = an exact revert of X) AND X was not itself such
 *                a revert. Proved from blob hashes in git history only — never from a commit message — so
 *                re-reverting a restore (revert of a revert of a revert) is still exit 9. The R-1962 shape:
 *                R-1899 (X) → c0159d00 / R-1905 (Y, put X's files back) → R-1962 brings X's version back.
 *
 * Rules 1 and 3 only warn when the range holds merge commits (a manager merge, not a worker card).
 * Escape: `--allow-outside <path>` (repeatable) skips all three rules for that path; every use is logged
 * in the lock folder's `_scope-guard.log` — write it in the card's liveLog too.
 *
 * `git` is injected ((args) => stdout, run at the repo top so paths are repo-root relative) so tests
 * drive every rule with a fake git.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const SCOPE_EXIT = 9;
export const SCOPE_BASE = "anutech/manager-pardeep";
export const REVERT_DAYS = 7;
export const GENERATED_FILES = [
  /^supabase\/cloudsql\/[^/]+\/deploy-db-[^/]*\.sh$/,
  /(^|\/)peeks\.generated\.ts$/,
  /(^|\/)database\.generated\.ts$/,
  /^docs\/API\.md$/,
];

/** Repo-root or production/-relative path → the same app-root form worker-lock uses ("../docs/x" → "docs/x"). */
export function scopePath(p) {
  let s = String(p).trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  while (s.startsWith("../")) s = s.slice(3);
  if (s.startsWith("production/")) s = s.slice("production/".length);
  return s;
}
const within = (area, p) => { const a = scopePath(area), x = scopePath(p); return !!a && (x === a || x.startsWith(a + "/")); };

export const isGenerated = (p) => GENERATED_FILES.some((re) => re.test(scopePath(p)));
export const isMigration = (p) => /^supabase\/migrations\/[^/]+\.sql$/.test(scopePath(p)) || /^prisma\/migrations\//.test(scopePath(p));
export const isTestFile = (p) => { const s = scopePath(p); return /(^|\/)(tests?|__tests__)\//.test(s) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(s); };

/** Name stem: "tests/worker-lock-guards.test.ts" → "worker-lock-guards"; "src/lib/deals" → "deals". */
const stem = (p) => scopePath(p).split("/").pop().replace(/\.(test|spec)(?=\.)/, "").replace(/\.[^.]+$/, "");

/** A test whose name stem matches (or extends with "-…") the stem of a claimed file/folder. */
export function testNextToClaim(p, areas) {
  if (!isTestFile(p)) return false;
  const s = stem(p);
  return areas.some((a) => { const t = stem(a); return t.length >= 3 && (s === t || s.startsWith(t + "-") || s.startsWith(t + ".")); });
}

/** `git diff --name-status [-z]` → [{status: "M"|"A"|"D"|…, file}] (renames come as D + A with --no-renames). */
export function parseNameStatus(out) {
  const s = String(out ?? "");
  const rows = [];
  if (s.includes("\0")) {
    const t = s.split("\0").filter((x) => x !== "");
    for (let i = 0; i < t.length; i++) {
      const st = t[i];
      if (/^[RC]/.test(st)) { rows.push({ status: "D", file: t[i + 1] }, { status: "A", file: t[i + 2] }); i += 2; }
      else { rows.push({ status: st[0], file: t[i + 1] }); i += 1; }
    }
  } else {
    for (const line of s.split(/\r?\n/)) {
      const [st, a, b] = line.split("\t");
      if (!st || !a) continue;
      if (/^[RC]/.test(st)) rows.push({ status: "D", file: a }, { status: "A", file: b });
      else rows.push({ status: st[0], file: a });
    }
  }
  return rows.filter((r) => r.file);
}

const meaningful = (l) => { const t = l.trim(); return t.length >= 6 && /[a-z0-9]/i.test(t) ? t : null; };

/** Trimmed meaningful lines a unified diff adds and removes: { added: Set, removed: Set }. */
export function diffLines(diff) {
  const added = new Set(), removed = new Set();
  for (const l of String(diff ?? "").split(/\r?\n/)) {
    if (l.startsWith("+++") || l.startsWith("---")) continue;
    const t = (l[0] === "+" || l[0] === "-") ? meaningful(l.slice(1)) : null;
    if (t) (l[0] === "+" ? added : removed).add(t);
  }
  return { added, removed };
}
export const removedLines = (diff) => diffLines(diff).removed;

/** `git log -p -U0 --format=%x1e%H%x09%s` → [{sha, subject, added: Set, removed: Set}]. */
export function parseLogPatches(out) {
  return String(out ?? "").split("\x1e").filter((c) => c.trim()).map((chunk) => {
    const lines = chunk.split(/\r?\n/);
    const [sha, ...subj] = lines[0].split("\t");
    return { sha: sha.trim(), subject: subj.join("\t").trim(), ...diffLines(lines.slice(1).join("\n")) };
  });
}

/**
 * Line-level revert of commit `c` by my diff `mine`. A refactor of another card's new lines is NOT a
 * revert; a revert also brings back what that commit took out. So: I delete ≥ half (and ≥ 3) of c's
 * new lines AND (c removed lines → I re-add ≥ half of them; c only added → I delete ≥ 80% of them).
 * Returns { hit, of } or null.
 */
export function lineRevert(c, mine) {
  if (!c.added.size) return null;
  const hit = [...c.added].filter((l) => mine.removed.has(l)).length;
  if (hit < 3 || hit * 2 < c.added.size) return null;
  if (c.removed.size) {
    const back = [...c.removed].filter((l) => mine.added.has(l)).length;
    return back * 2 >= c.removed.size ? { hit, of: c.added.size, back } : null;
  }
  return hit * 5 >= c.added.size * 4 ? { hit, of: c.added.size } : null;
}

export const cardOf = (subject) => (/\b(R-\d+)\b/i.exec(String(subject)) ?? [])[1]?.toUpperCase() ?? null;

/**
 * R-1964: commit `c` (one of `commits`, newest first) is an exact revert when its version of `file` is
 * the version from before an OLDER commit `x` of another card (x also inside the 7-day window).
 * Returns that `x`, or null. Blob hashes only.
 */
function exactRevertTarget(c, commits, file, blob) {
  const after = blob(`${c.sha}:${file}`);
  if (!after) return null;
  return commits.slice(commits.indexOf(c) + 1)
    .find((x) => cardOf(x.subject) !== cardOf(c.subject) && blob(`${x.sha}^:${file}`) === after) ?? null;
}

/**
 * R-1964: my change restores what `c` wrongly reverted — the file is back to exactly c's parent version,
 * c had put it back to before an older card's commit X, and X was original work (not itself a revert).
 * Returns X, or null.
 */
function restoredFrom(c, commits, file, blob, now) {
  if (!now || blob(`${c.sha}^:${file}`) !== now) return null;
  const x = exactRevertTarget(c, commits, file, blob);
  if (!x || exactRevertTarget(x, commits, file, blob)) return null;
  return x;
}

/**
 * Rule 3 for one file. Returns a "why" string, or null when nothing of another card's is undone.
 * `notes` (optional array) gets one line per allowed RESTORE (R-1964).
 */
export function revertOf(card, file, status, { git, base, mode, sinceDays = REVERT_DAYS, notes = null }) {
  const id = String(card).toUpperCase();
  let commits;
  try {
    commits = parseLogPatches(git(["log", `--since=${sinceDays}.days.ago`, "--no-merges", "--no-color", "--no-ext-diff", "-p", "-U0", "--format=%x1e%H%x09%s", base, "--", file]))
      .filter((c) => cardOf(c.subject) !== id);
  } catch { return null; }
  if (!commits.length) return null;
  const range = mode === "commits" ? [base, "HEAD"] : [base];
  const blobs = new Map();
  const blob = (spec) => {
    if (!blobs.has(spec)) { let v = null; try { v = git(["rev-parse", spec]).trim() || null; } catch {} blobs.set(spec, v); }
    return blobs.get(spec);
  };
  const restored = new Set();
  if (status === "M") {
    let now = null;
    try { now = (mode === "commits" ? git(["rev-parse", `HEAD:${file}`]) : git(["hash-object", "--", file])).trim(); } catch {}
    for (const c of commits) {
      const before = blob(`${c.sha}^:${file}`);
      if (!(now && before && now === before)) continue;
      const x = restoredFrom(c, commits, file, blob, now);
      if (x) {
        restored.add(c.sha);
        notes?.push(`ℹ [restore] ${scopePath(file)} — ${cardOf(x.subject) ?? "doosre"} commit ${x.sha.slice(0, 8)} ka kaam wapas; ${cardOf(c.subject) ?? "doosre"} commit ${c.sha.slice(0, 8)} ne use hata diya tha (git history se pakka) — revert nahi gina`);
        continue;
      }
      return `file wapas ${cardOf(c.subject) ?? "doosre"} commit ${c.sha.slice(0, 8)} ("${c.subject.slice(0, 60)}") se PEHLE wale roop me — us card ka kaam ulat jaayega`;
    }
  }
  let mine;
  try { mine = diffLines(git(["diff", "--no-color", "--no-ext-diff", "-U0", ...range, "--", file])); } catch { return null; }
  for (const c of commits) {
    if (restored.has(c.sha)) continue;
    const r = lineRevert(c, mine);
    if (r) return `${cardOf(c.subject) ?? "doosre"} commit ${c.sha.slice(0, 8)} ("${c.subject.slice(0, 60)}") ki ${r.hit}/${r.of} nayi lines hata di${r.back ? `, aur uski hatayi ${r.back} purani lines wapas` : ""} (pichhle ${sinceDays} din ka kaam)`;
  }
  return null;
}

/**
 * The guard, pure: { ok, refused: [{rule, file, status, why}], warnings: [], allowedUsed: [], message }.
 * mode "commits" = merge-base..HEAD (push); "worktree" = merge-base..working tree (check, before the commit).
 */
export function checkScope(card, { git, areas = [], allowOutside = [], mode = "commits", sinceDays = REVERT_DAYS } = {}) {
  const id = String(card).toUpperCase();
  const claimed = [...new Set(areas.map(scopePath).filter(Boolean))];
  const base = git(["merge-base", "HEAD", SCOPE_BASE]).trim();
  const range = mode === "commits" ? [base, "HEAD"] : [base];
  const changes = parseNameStatus(git(["diff", "--name-status", "-z", "--no-renames", ...range]));
  let merges = false;
  try { merges = git(["rev-list", "--merges", `${base}..HEAD`]).trim().length > 0; } catch {}
  const refused = [], warnings = [], allowedUsed = [], restored = [];
  const refuse = (rule, c, why) => (merges && rule !== "migration" ? warnings.push(`⚠ [${rule}] ${scopePath(c.file)} — ${why} (merge commit hai, sirf chetavni)`) : refused.push({ rule, file: c.file, status: c.status, why }));
  if (!claimed.length) warnings.push(`⚠ ${id}: claim ke areas nahi mile (lock nahi?) — "area ke bahar" jaanch nahi hui, sirf migration + revert jaanch.`);
  for (const c of changes) {
    const p = scopePath(c.file);
    if (allowOutside.some((a) => within(a, p))) { allowedUsed.push(p); continue; }
    if (isMigration(p)) {
      if (c.status === "A") continue;
      /* The card's OWN migration from an earlier push (not yet deployed, e.g. a re-stamp) only warns. */
      let addedBy = null;
      try { addedBy = cardOf(git(["log", "--diff-filter=A", "--format=%s", "-1", base, "--", c.file])); } catch {}
      if (addedBy === id) warnings.push(`⚠ [migration] ${p} (${c.status}) — isi card ki pichhli push wali migration; deploy ho chuki ho to nayi migration likho`);
      else refuse("migration", c, `purani migration${addedBy ? ` (${addedBy} ki)` : ""} badli/hatayi — deploy ho chuki migration kabhi mat chhuo; nayi migration likho`);
      continue;
    }
    if (isGenerated(p)) continue;
    const inArea = claimed.some((a) => within(a, p));
    if (claimed.length && !inArea) {
      if (c.status === "A") { if (!isTestFile(p)) warnings.push(`⚠ naya file claim ke bahar: ${p} — claim me jodo`); continue; }
      if (!testNextToClaim(p, claimed)) { refuse("area", c, `card ke claim ke bahar (${c.status === "D" ? "hatayi" : "badli"})`); continue; }
    }
    if (c.status === "M" || c.status === "D") {
      const why = revertOf(id, c.file, c.status, { git, base, mode, sinceDays, notes: restored });
      if (why) refuse("revert", c, why);
    }
  }
  const ok = !refused.length;
  const lines = [];
  if (ok) lines.push(`✓ ${id}: ${changes.length} badli files — doosre card ka kaam ulta nahi, purani migration nahi chhui.`);
  else {
    lines.push(`✗ ${id}: ye ${mode === "commits" ? "push" : "commit"} doosre card ka kaam ULAT dega — RUKA (exit ${SCOPE_EXIT}). Ye files:`);
    for (const r of refused) lines.push(`   [${r.rule}] ${scopePath(r.file)} (${r.status}) — ${r.why}`);
    lines.push(`   Claim: ${claimed.join(", ") || "(koi nahi)"}`);
    lines.push("   Aksar wajah: purane base par `git reset --soft` / purani copy. Theek karo: git fetch anutech, apni hi files naye anutech/manager-pardeep par dobara lagao (git diff dekho), phir dobara.");
    lines.push(`   Sach me card ko ye file badalni hai → claim me jodo, ya --allow-outside <path> (log hota hai; card ke liveLog me bhi likho).`);
  }
  if (allowedUsed.length) lines.push(`⚠ --allow-outside se chhodi: ${allowedUsed.join(", ")} (log me likha)`);
  return { ok, refused, warnings, allowedUsed, restored, message: [...lines, ...restored, ...warnings].join("\n") };
}

/** Pull `--allow-outside <path>` / `--allow-outside=<path>` (repeatable) out of the args. */
export function parseScopeFlags(args) {
  const rest = [], allowOutside = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--allow-outside") { const v = args[++i]; if (v) allowOutside.push(v); }
    else if (a.startsWith("--allow-outside=")) allowOutside.push(a.slice(16));
    else rest.push(a);
  }
  return { rest, allowOutside };
}

/** Claimed areas: the lock's `areas` (from claim — not `files`, which `check` grows) + the card file's `files`. */
export function claimedAreas(lock, card) {
  const fromCard = Array.isArray(card?.files) ? card.files : Array.isArray(card?.data?.files) ? card.data.files : [];
  return [...(Array.isArray(lock?.areas) ? lock.areas : []), ...fromCard.filter((f) => typeof f === "string")];
}

/** Real git at the repo top (paths in diff output are repo-root relative). */
export function realScopeGit() {
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  return (args) => execFileSync("git", args, { cwd: top, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

/**
 * CLI step for worker-lock `check` / `push`: prints, logs --allow-outside, exits 9 on a refusal.
 * A tool failure (git error) only warns — it never blocks a push on its own.
 */
export function enforceScope(card, mode, { lockDir, allowOutside = [], cardPath = null, git = null, exit = (c) => process.exit(c) } = {}) {
  const id = String(card).toUpperCase();
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
  const areas = claimedAreas(readJson(path.join(lockDir, `${id}.json`)), cardPath ? readJson(cardPath) : null);
  let r;
  try { r = checkScope(id, { git: git ?? realScopeGit(), areas, allowOutside, mode }); }
  catch (e) { console.log(`⚠ ${id}: scope jaanch nahi chal paayi (${String(e?.message ?? e).split("\n")[0].slice(0, 200)}) — chhodi.`); return true; }
  if (r.allowedUsed.length) {
    try { fs.appendFileSync(path.join(lockDir, "_scope-guard.log"), JSON.stringify({ at: new Date().toISOString(), card: id, mode, allowOutside: r.allowedUsed }) + "\n"); } catch {}
  }
  (r.ok ? console.log : console.error)(r.message);
  if (!r.ok) exit(SCOPE_EXIT);
  return r.ok;
}
