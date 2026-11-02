/**
 * R-2356 (2 Nov 2026) — workers never use `git stash`; worker-lock catches a stash made during a card.
 *
 * 2 Nov: the R-2355 worker ran `git stash` + `git stash pop` on a clean tree. Nothing of its own was
 * stashed, so the pop applied stash@{0} — R-2225's unfinished WIP — into its worktree (with a conflict).
 * Every worktree of a clone shares ONE stash list (refs/stash lives in the common git dir), so one
 * worker can pick up another's half-done code. Rule (docs/WORKER-STEPS.md): commit a `WIP <CARD>:`
 * and `worker-lock wip <CARD>` instead.
 *
 *   claim  — records the stash list (entry shas + time) on the lock as `stashAtClaim`.
 *   check / push — read it again: an entry added since the claim whose branch is this card's branch
 *            (or unknown, e.g. a detached HEAD) → stop with exit 10. A new entry on another worker's
 *            branch, or an entry present at claim that is gone now (popped/dropped), only warns.
 *            Old lock without a snapshot → only an entry naming this card's branch stops.
 *
 * Read-only: only `git stash list` is ever run — this never pops, applies, drops or clears an entry.
 * git failing → warn, never block. `git` is injected ((args) => stdout) so tests use a fake.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";

export const STASH_EXIT = 10;

/** Real git, run in the current worktree (read-only use: `stash list`, `rev-parse`). */
export const stashGit = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * check/push: `lock` is the lock object or the lock file's path (missing/unreadable → no snapshot).
 * Prints the warnings; on a stop prints the message and calls exit(10).
 */
export function enforceStash(card, lock, { git = stashGit, print = console.log, printErr = console.error, exit = (c) => process.exit(c) } = {}) {
  let me = lock;
  if (typeof lock === "string") { try { me = JSON.parse(fs.readFileSync(lock, "utf8")); } catch { me = null; } }
  let branch = "";
  try { branch = String(git(["rev-parse", "--abbrev-ref", "HEAD"])).trim(); } catch {}
  const v = stashVerdict({ card, branch: branch === "HEAD" ? "" : branch, atClaim: me?.stashAtClaim, now: readStash(git) });
  for (const w of v.warn) print(w);
  if (!v.ok) { printErr(v.message); exit(v.exit); }
  return v;
}

/** "WIP on w-r-2356: abc msg" / "On w-r-2356: msg" → "w-r-2356"; "(no branch)" or anything else → null. */
export function stashBranch(subject) {
  const m = /^(?:WIP on|On) ([^:]+):/.exec(String(subject ?? ""));
  if (!m || m[1] === "(no branch)") return null;
  return m[1].trim();
}

/** The shared stash list, newest first: [{sha, subject, branch}]; null when git fails. */
export function readStash(git) {
  let out;
  try { out = git(["stash", "list", "--format=%H%x09%gs"]); } catch { return null; }
  return String(out ?? "").split("\n").map((l) => l.replace(/\r$/, "")).filter(Boolean).map((l) => {
    const i = l.indexOf("\t");
    const sha = i < 0 ? l.trim() : l.slice(0, i).trim();
    const subject = i < 0 ? "" : l.slice(i + 1);
    return { sha, subject, branch: stashBranch(subject) };
  });
}

/** What `claim` stores on the lock; null when git fails (then check/push fall back to the branch rule). */
export function stashSnapshot(git, at) {
  const s = readStash(git);
  return s ? { at, shas: s.map((e) => e.sha), subjects: Object.fromEntries(s.map((e) => [e.sha, e.subject])) } : null;
}

/**
 * Decide for check/push. `atClaim` = the lock's stashAtClaim (may be missing on an old lock), `now` =
 * readStash() now (null = git failed). The snapshot keeps each entry subject so a vanished one can be named. Returns {ok, exit?, message?, warn: string[]}.
 */
export function stashVerdict({ card, branch, atClaim, now }) {
  const warn = [];
  if (!now) return { ok: true, warn: ["(R-2356: git stash list nahi padh paaye — stash guard chhoda)"] };
  const mine = branch || `w-${String(card).toLowerCase()}`;
  const before = atClaim && Array.isArray(atClaim.shas) ? new Set(atClaim.shas) : null;
  const added = before ? now.filter((e) => !before.has(e.sha)) : now.filter((e) => e.branch === mine);
  const stop = added.filter((e) => e.branch === mine || e.branch === null);
  for (const e of added.filter((x) => !stop.includes(x))) {
    warn.push(`(R-2356: claim ke baad naya stash "${e.subject}" — ${e.branch} ka hai, tumhara nahi. Use haath mat lagao.)`);
  }
  if (before) {
    const nowShas = new Set(now.map((e) => e.sha));
    for (const sha of before) if (!nowShas.has(sha)) warn.push(`(R-2356: claim ke waqt wala stash ${sha.slice(0, 9)} ("${atClaim.subjects?.[sha] ?? "?"}") ab list me nahi — kisi ne pop/drop kiya. Agar tumne kiya: wo kisi aur worker ka WIP ho sakta hai, apne worktree me aayi badli files dekho aur Pardeep ko batao.)`);
  }
  if (!stop.length) return { ok: true, warn };
  const lines = stop.map((e) => `   ${e.sha.slice(0, 9)}  ${e.subject}`).join("\n");
  const message = [
    `✗ R-2356: ${card} ke claim ke baad git stash me naya entry bana — git stash mat chalao (stash list har worktree ki SAANJHI hai):`,
    lines,
    `Ab: (1) apna kaam wapas lao — sirf APNA entry, sha se: git stash apply <upar wala sha>; kisi aur ka entry (jaise "WIP on w-r-xxxx") kabhi pop/apply/drop mat karo.`,
    `    (2) commit karo: git commit -m "WIP ${card}: …" aur node scripts/ops/worker-lock.mjs wip ${card}.`,
    `    (3) apna applied entry hatao: git stash drop <usi entry ka stash@{n}> — sirf jab wo upar wala sha ho. Phir check dobara.`,
    `Never use git stash — commit a WIP instead; never pop/apply/drop another worker's entry.`,
  ].join("\n");
  return { ok: false, exit: STASH_EXIT, message, warn };
}
