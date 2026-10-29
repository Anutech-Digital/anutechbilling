/**
 * R-2105 (29 Oct 2026) — files DERIVED from the migrations folder never block another worker.
 *
 * 29 Oct measured: every card with a migration held src/server/migrations-health/peeks.generated.ts and
 * supabase/cloudsql/{staging,live}/deploy-db-<date>.sh in its lock, and kept them through ci-wait
 * (CI ~45–60 min). R-2101 waited ~1 h behind R-2099, then R-2102 1 h+ behind R-2101. Those files are
 * written by scripts/ops/gen-deploy-db.mjs from supabase/migrations/*.sql — nobody edits them by hand,
 * so two cards "touching" them is never a real clash. Now:
 *
 *   claim / check — derived files are left out of conflict detection and out of the lock.
 *   push          — after the rebase, gen-deploy-db runs again (same generator tests/gen-deploy-db.test.ts
 *                   checks) and the result is folded into the card's own commit. A rebase conflict ONLY
 *                   in derived files is resolved the same way (take the base side, regenerate, continue);
 *                   any other conflict still aborts and stops.
 *
 * `git` is injected ((args, {env}) => stdout, run at the repo top; throws on non-zero) and so is
 * `regen` (() => void, rewrites the derived files), so tests drive this with a real temp repo.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";

/** Same as worker-lock.mjs normPath (kept here so the two modules do not import each other). */
function normPath(p) {
  let s = String(p).trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (s.startsWith("production/")) s = s.slice("production/".length);
  return s;
}

/** App-root relative (production/ stripped). Only what gen-deploy-db writes. */
export const MIGRATION_DERIVED = [
  /^supabase\/cloudsql\/(staging|live)\/deploy-db-\d{4}-\d{2}-\d{2}\.sh$/,
  /^src\/server\/migrations-health\/peeks\.generated\.ts$/,
];

export const isDerived = (p) => MIGRATION_DERIVED.some((re) => re.test(normPath(p)));
export const withoutDerived = (paths) => (paths ?? []).filter((p) => !isDerived(p));

/** Newest date that has BOTH a staging and a live deploy-db script (the one gen-deploy-db must rewrite). */
export function newestDeployDate(stagingNames, liveNames) {
  const dates = (names) => new Set((names ?? []).map((n) => /^deploy-db-(\d{4}-\d{2}-\d{2})\.sh$/.exec(n)?.[1]).filter(Boolean));
  const live = dates(liveNames);
  return [...dates(stagingNames)].filter((d) => live.has(d)).sort().pop() ?? null;
}

/** Repo-root paths from `git status --porcelain` that are derived and changed (staged or not). */
function changedDerived(git) {
  return git(["status", "--porcelain", "--untracked-files=all"]).split("\n").filter(Boolean)
    .map((l) => l.slice(3).split(" -> ").pop().trim().replace(/^"|"$/g, ""))
    .filter(isDerived);
}

/** Run the generator and stage whatever it changed. Returns the staged repo-root paths. */
export function regenerateDerived({ git, regen }) {
  regen();
  const changed = changedDerived(git);
  if (changed.length) git(["add", "--", ...changed]);
  return changed;
}

/**
 * After the rebase: regenerate, and if anything changed fold it into the card's newest commit (when HEAD
 * is the card's own, non-merge commit) or add one "<CARD>: regenerate …" commit. Returns
 * { changed: [...], how: "none"|"amend"|"commit" }.
 */
export function refreshDerived(card, { git, regen }) {
  const id = String(card).toUpperCase();
  const changed = regenerateDerived({ git, regen });
  if (!changed.length) return { changed, how: "none" };
  const subject = git(["log", "-1", "--format=%s"]).trim();
  const parents = git(["log", "-1", "--format=%P"]).trim().split(/\s+/).filter(Boolean);
  const own = new RegExp(`^${id}\\b`, "i").test(subject) && parents.length === 1;
  if (own) { git(["commit", "-q", "--amend", "--no-edit", "--no-verify"]); return { changed, how: "amend" }; }
  git(["commit", "-q", "--no-verify", "-m", `${id}: regenerate deploy-db + peeks after rebase (R-2105)`]);
  return { changed, how: "commit" };
}

/**
 * `git rebase` onto `base`, resolving conflicts that sit ONLY in derived files: take the base side
 * ("ours" during a rebase), regenerate from the merged migrations folder, continue. A conflict in any
 * other file → abort, { ok: false, conflicts }. Returns { ok, resolved: number of stops auto-resolved }.
 */
export function rebaseResolvingDerived(base, { git, regen, maxSteps = 200 }) {
  const env = { ...process.env, GIT_EDITOR: "true" };
  let resolved = 0;
  let step = () => git(["rebase", "-q", "--rebase-merges", base], { env });
  for (let i = 0; i < maxSteps; i++) {
    try { step(); return { ok: true, resolved }; } catch (e) {
      const conflicts = git(["diff", "--name-only", "--diff-filter=U"]).split("\n").map((s) => s.trim()).filter(Boolean);
      const other = conflicts.filter((f) => !isDerived(f));
      if (!conflicts.length || other.length) {
        try { git(["rebase", "--abort"]); } catch {}
        return { ok: false, conflicts: other.length ? other : conflicts, error: String(e?.stderr ?? e?.message ?? e).slice(-600) };
      }
      git(["checkout", "--ours", "--", ...conflicts]);
      git(["add", "--", ...conflicts]);
      regenerateDerived({ git, regen });
      resolved++;
      /* The commit may have held only derived files that now equal the base → nothing left to commit. */
      let empty = false;
      try { git(["diff", "--cached", "--quiet"]); empty = true; } catch {}
      step = empty ? () => git(["rebase", "--skip"], { env }) : () => git(["rebase", "--continue"], { env });
    }
  }
  try { git(["rebase", "--abort"]); } catch {}
  return { ok: false, conflicts: [], error: `rebase did not finish in ${maxSteps} steps` };
}

/**
 * settleCiWaitLocks' loop (worker-lock.mjs): every ci-wait lock that clashes with `mine` and whose
 * verdict(lock) is "green" is removed. Returns the locks still standing.
 */
export function settleLocks(card, mine, locks, { findConflicts, verdict, remove, print = () => {} }) {
  const blocking = new Set(findConflicts(card, mine, locks).map((c) => c.card));
  const gone = new Set();
  for (const l of locks) {
    if (!blocking.has(l.card) || l.state !== "ci-wait") continue;
    const v = verdict(l);
    if (v === "green") {
      remove(l.card);
      gone.add(l.card);
      print(`  ${l.card} ci-wait tha aur ${String(l.pushedSha).slice(0, 8)} ka CI green hai — uska lock hata diya (files khaali).`);
    } else if (v) print(`  ${l.card} ci-wait: CI ${v} — lock rahega.`);
  }
  return locks.filter((l) => !gone.has(l.card));
}

/** R-2105: real git (at the repo top) + gen-deploy-db for the newest deploy date, run from production/. */
export function realDerivedDeps(app = process.cwd()) {
  const top = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  const git = (args, opts = {}) => execFileSync("git", args, { cwd: top, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...(opts.env ? { env: opts.env } : {}) });
  const regen = () => {
    const dir = (env) => { try { return fs.readdirSync(path.join(app, "supabase", "cloudsql", env)); } catch { return []; } };
    const date = newestDeployDate(dir("staging"), dir("live"));
    const gen = path.join(app, "scripts", "ops", "gen-deploy-db.mjs");
    if (!date || !fs.existsSync(gen)) return;
    execFileSync(process.execPath, [gen, "--date", date], { cwd: app, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  };
  return { git, regen };
}

