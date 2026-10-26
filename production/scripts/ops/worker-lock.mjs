/**
 * Worker locks — two worker sessions must never build in the same files (6 Oct 2026).
 *
 * Pardeep: "dhyan rakhne wali baat ka koi aisa solid system banao ki ye galti na ho paye".
 * Every worker session (docs/WORKER-SESSION-PROMPT.md) runs on this one machine, so a lock
 * file per card in ~/.claude/worker-locks is something every worker can see. Two checks:
 *
 *   claim  — before any code: the folders/files the card will touch. Refused if another
 *            live worker already holds an overlapping path.
 *   check  — before every commit/push: the files ACTUALLY changed in this worktree. Catches
 *            the card that turned out to touch more than it claimed. Adds them to the lock.
 *
 * A lock whose worktree folder is gone is stale (session crashed or cleaned up) and is
 * removed automatically, so a dead session cannot block the queue forever.
 *
 *   node scripts/ops/worker-lock.mjs claim   R-197 C:/Users/mso50/reselleros-w-r-197 src/app/(app)/deals src/lib/deals
 *   node scripts/ops/worker-lock.mjs check   R-197      (run inside the worktree)
 *   node scripts/ops/worker-lock.mjs release R-197
 *   node scripts/ops/worker-lock.mjs push    R-197      (inside the worktree: waits its turn, rebases, pushes)
 *   node scripts/ops/worker-lock.mjs list
 *   node scripts/ops/worker-lock.mjs prep    R-197 <path>...   (manager, before a card is given out)
 *   node scripts/ops/worker-lock.mjs wip     R-197               (R-1898: worktree HEAD → anutech wip/r-197)
 *   node scripts/ops/worker-lock.mjs resume  R-197 <worktree>    (R-1898: any laptop picks up a stopped card)
 *
 * prep — card prep (6 Oct: R-202's card named a page that does not exist; R-197's page was a
 * re-export of leads/page.tsx). For every path: does it exist, and if it is a one-line
 * re-export, where the real code is. Prints the lockAreas to write on the card. Exit 1 if a
 * path is missing — fix the card before a worker gets it.
 *
 * push — one worker pushes at a time (6 Oct: 6 of 8 workers had their push rejected because
 * another worker pushed in the same minute). Waits for the push turn, then fetch + rebase +
 * typecheck + push. A rebase conflict aborts and stops (exit 2) — never resolved by force.
 *
 * Exit 0 = go. Exit 2 = conflict (message names the other card). Exit 5 = push guard test failed
 * (R-385: repo-scan/ratchet suites in push-guard-suites.mjs). Exit 3 = maxWorkersAt() (2 by day, 3 by night) already
 * running. Either way: stop, do not work around it.
 *
 * R-842 (11 Oct) — board v76 card contract, enforced here instead of by cleanup (400+ cards lacked fields).
 * The script cannot read the board (claude.ai artifact DB), so the caller saves the card first with
 * ArtifactData get … out_dir=<dir> and passes the file:
 *   node scripts/ops/worker-lock.mjs claim R-197 <worktree> <area>... --card <dir>/cards/R-197.json
 *   node scripts/ops/worker-lock.mjs push  R-197 --card <dir>/cards/R-197.json   (re-save after writing howToCheck)
 * claim needs triage {verdict, why, at}, kind, category, doneWhen; push needs howToCheck. Commits are
 * NOT checked: the sha exists only after the push, so the worker/dispatcher writes `commits` right after.
 * `--no-card-check` skips this ONLY for R-9xx manager cards. Exit 6 = card contract missing / no --card.
 *
 * R-1936: push also refuses on a red manager-pardeep CI (exit 7; --fixes-red / --owner-override) and on a
 * red related SQL test (exit 5). `ci <CARD>` waits for the sha's CI + SQL runs (exit 0 / 7 red / 8 timeout).
 * R-1958: check + push (before AND after the rebase) refuse with exit 9 a change that undoes other cards'
 * work — outside the claim, an old migration touched, a revert (worker-lock-guards.mjs; --allow-outside <path>).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { restoreBuildInfo, saveBuildInfo, dropBuildInfo, parseTscFlags, TSC_FULL_STEP } from "./worker-tsc-cache.mjs";
import { execSync, execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PUSH_GUARD_SUITES, PUSH_GUARD_BUDGET_MS, failedSuites } from "./push-guard-suites.mjs";
import { enforceScope, parseScopeFlags } from "./worker-lock-guards.mjs";

export const LOCK_DIR = process.env.WORKER_LOCK_DIR || path.join(os.homedir(), ".claude", "worker-locks");

/** "production/src/x/" and "src\\x" both become "src/x" — paths are compared from the app root. */
export function normPath(p) {
  let s = String(p).trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (s.startsWith("production/")) s = s.slice("production/".length);
  return s;
}

/** Same path, or one is a folder holding the other. "src/lib/deal" does NOT overlap "src/lib/deals". */
export function pathsOverlap(a, b) {
  const x = normPath(a), y = normPath(b);
  return x === y || y.startsWith(x + "/") || x.startsWith(y + "/");
}

/**
 * A claim like "src" or "src/app" would lock out every other worker — refuse it.
 * R-345: an exact FILE (name with an extension, e.g. sentry.client.config.ts,
 * scripts/setup-cloud-scheduler.sh) locks only itself, so it is fine at any depth.
 * Folders still need 3 parts; ".", "*" and wildcards are always refused.
 */
export function tooBroad(area) {
  const n = normPath(area);
  if (!n || n === "." || n.includes("*")) return true;
  const parts = n.split("/").filter(Boolean);
  if (/^[^.].*\.[a-z0-9]{1,8}$|^\..+\..+$/i.test(parts[parts.length - 1])) return false;
  return parts.length < 3;
}

/** Most workers allowed at once. 6 Oct 2026: 8 at once left 2 GB of 24 GB free and hung the machine. */
export const MAX_WORKERS = Number(process.env.WORKER_MAX || 4);

/**
 * Pardeep (6 Oct night): the local app crawled while 4 workers type-checked. While he works
 * (09:00–21:59 IST) only 2 workers run; at night 4. WORKER_MAX still overrides.
 * R-1960 (26 Oct 2026): night cap 4 → 3 — 4 parallel tsc runs took the laptop to ~90 node processes.
 */
export function maxWorkersAt(date) {
  if (process.env.WORKER_MAX) return Number(process.env.WORKER_MAX);
  const h = Number(new Date(date).toLocaleString("en-US", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false })) % 24;
  return h >= 9 && h < 22 ? 2 : 3;
}

/**
 * R-1973 (26 Oct 2026): a pushed card that only waits for GitHub CI (20–25 min in `worker-lock ci`)
 * runs no tsc and no tests on this laptop, yet it filled a slot — R-1920 was refused with exit 3 while
 * R-1961 was only waiting on CI. Lock states:
 *   working (no state field = old locks) — counts toward the cap, holds its files;
 *   ci-wait — set by a successful push: does NOT count toward the cap, still HOLDS its files
 *             (no other card may touch them until CI says green or red);
 *   ci-red  — set by `ci` on red: still holds its files, does not count until the same card takes a
 *             slot back with `claim <CARD> --fixes-red` (allowed even when the cap is full — red first).
 * `ci` green removes the lock (files free). A push sets the card back to working while it runs.
 */
export const LOCK_STATES = { working: "working", ciWait: "ci-wait", ciRed: "ci-red" };

/** Does this lock use one of the cap's slots? Only a card that is actually being built does. */
export function countsTowardCap(lock) {
  return !lock || (lock.state !== LOCK_STATES.ciWait && lock.state !== LOCK_STATES.ciRed);
}

/** True when another worker may not start: the live locks (other cards) already fill every slot. */
export function queueFull(card, locks, max = maxWorkersAt(Date.now())) {
  return locks.filter((l) => l.card !== card && countsTowardCap(l)).length >= max;
}

/** The lock after a successful push: waiting on CI, files kept, slot freed. */
export function lockAfterPush(lock, { sha, at }) {
  return { ...lock, state: LOCK_STATES.ciWait, ciWaitSince: at, pushedSha: sha };
}

/**
 * The lock after `ci` gave a verdict (CI_EXIT code). green → null (lock removed, files free);
 * red → ci-red (files kept; take the slot back with claim --fixes-red); timeout → unchanged.
 */
export function lockAfterCi(lock, code, { at }) {
  if (!lock) return lock;
  if (code === 0) return null;
  if (code === 7) return { ...lock, state: LOCK_STATES.ciRed, ciRedAt: at };
  return lock;
}

/** The lock while the card is being built again (re-claim or a new push): back in a slot. */
export function lockWorking(lock) {
  const { ciWaitSince: _a, ciRedAt: _b, ...rest } = lock;
  return { ...rest, state: LOCK_STATES.working };
}

/**
 * claim's cap decision, pure. `own` = this card's existing lock (or null). A card whose own lock is
 * waiting on CI / red takes its slot back with --fixes-red even when the cap is full (stop the line on
 * red, R-1936); anything else waits for a free slot. Returns { ok, overCap }.
 */
export function claimSlot(card, locks, { fixesRed = false, max = maxWorkersAt(Date.now()) } = {}) {
  const own = locks.find((l) => l.card === card) ?? null;
  const full = queueFull(card, locks, max);
  if (!full) return { ok: true, overCap: false };
  if (fixesRed && own && !countsTowardCap(own)) return { ok: true, overCap: true };
  return { ok: false, overCap: false };
}

/** Every pair of overlapping paths between my claims and other live locks. */
export function findConflicts(card, mine, locks) {
  const out = [];
  for (const l of locks) {
    if (l.card === card) continue;
    const theirs = [...(l.areas ?? []), ...(l.files ?? [])];
    for (const m of mine) for (const t of theirs) {
      if (pathsOverlap(m, t)) out.push({ card: l.card, mine: normPath(m), theirs: normPath(t) });
    }
  }
  return out;
}

function lockFile(card, dir = LOCK_DIR) { return path.join(dir, `${card.toUpperCase()}.json`); }

/** Read-modify-write one card's lock file (R-1973). fn(lock) → new lock, or null to remove. No lock → no-op. */
export function updateLock(card, fn, dir = LOCK_DIR) {
  const f = lockFile(card, dir);
  let lock;
  try { lock = JSON.parse(fs.readFileSync(f, "utf8")); } catch { return { found: false }; }
  const next = fn(lock);
  if (next === null) fs.rmSync(f, { force: true });
  else fs.writeFileSync(f, JSON.stringify(next, null, 2));
  return { found: true, lock: next };
}

export function readLocks() {
  if (!fs.existsSync(LOCK_DIR)) return [];
  const live = [];
  for (const f of fs.readdirSync(LOCK_DIR).filter((n) => n.endsWith(".json") && !n.startsWith("_"))) {
    const full = path.join(LOCK_DIR, f);
    let l;
    try { l = JSON.parse(fs.readFileSync(full, "utf8")); } catch { continue; }
    if (!l.worktree || !fs.existsSync(l.worktree)) {
      fs.rmSync(full, { force: true });
      console.log(`(stale lock ${l.card ?? f} removed — its worktree folder is gone)`);
      continue;
    }
    live.push(l);
  }
  return live;
}

function report(conflicts) {
  console.error("✗ TAKRAAV — dusra worker inhi files par kaam kar raha hai:");
  for (const c of conflicts) console.error(`   ${c.card}: ${c.theirs}   ↔   tumhara: ${c.mine}`);
  console.error("Ruko. Owner ko batao: \"" + [...new Set(conflicts.map((c) => c.card))].join(", ") +
    " khatam hone ke baad ye card chalaiye, ya koi aur card dijiye.\" Lock ko haath mat lagao.");
  process.exit(2);
}

function changedFiles() {
  const base = execSync("git merge-base HEAD anutech/manager-pardeep", { encoding: "utf8" }).trim();
  const committed = execSync(`git diff --name-only ${base} HEAD`, { encoding: "utf8" });
  const working = execSync("git status --porcelain --untracked-files=all", { encoding: "utf8" })
    .split("\n").filter(Boolean).map((l) => l.slice(3).split(" -> ").pop());
  return [...new Set([...committed.split("\n"), ...working].map((s) => s.trim()).filter(Boolean).map(normPath))];
}

/** A push turn older than this is from a crashed worker and may be taken over. */
export const PUSH_TURN_STALE_MS = 15 * 60 * 1000;

export function pushTurnFree(turn, now) {
  return !turn || now - turn.at > PUSH_TURN_STALE_MS;
}

function sh(cmd, env) { return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...(env ? { env } : {}) }); }

/**
 * R-1814: the line a waiting worker prints. It used to start with the OTHER card ("… R-1813 push kar
 * raha hai"), and a waiting worker's summary reported that card as its own. Now it starts with mine.
 */
export function waitLine(name, card, otherCard, doing) {
  return `… ${card}: ${name} ki baari ka intezaar — abhi doosra worker ${otherCard ?? "(koi)"} ${doing}`;
}

/**
 * R-1814: decide the push from MY commits — `anutech/manager-pardeep..HEAD` after the rebase, newest
 * first, as [{sha, subject}]. Before, the success line printed `git rev-parse HEAD`: when the rebase
 * dropped my commits (already upstream) or I had none, HEAD was the other worker's tip, so a waiting
 * worker reported "R-1813 push ho gaya: 9e4f6dfc". Nothing of mine → no push. Commits named for
 * another card are listed so the worker can see it is carrying someone else's work.
 */
export function pushPlan(card, commits) {
  const id = String(card).toUpperCase();
  if (!commits.length) {
    return { ok: false, message: `✗ ${id}: rebase ke baad push karne ko apna kuch nahi (anutech/manager-pardeep me pehle se hai ya commit hi nahi hua). Push nahi kiya — git log dekho.` };
  }
  const foreign = commits
    .filter((c) => { const m = /^(R-\d+)\b/i.exec(c.subject); return m && m[1].toUpperCase() !== id; })
    .map((c) => `${c.sha} ${c.subject}`);
  return { ok: true, sha: commits[0].sha, count: commits.length, foreign };
}

export function pushDoneLine(card, plan) {
  return `✓ ${String(card).toUpperCase()} push ho gaya: ${plan.sha} (${plan.count} commit apne)`;
}

/** Wait for a named turn (one holder at a time across all workers), run fn, release. */
async function withTurn(name, card, doing, fn) {
  const turnFile = path.join(LOCK_DIR, `_${name}-turn.json`);
  const waitUntil = Date.now() + 30 * 60 * 1000;
  for (;;) {
    let turn = null;
    try { turn = JSON.parse(fs.readFileSync(turnFile, "utf8")); } catch {}
    if (turn && turn.card === card) { fs.rmSync(turnFile, { force: true }); turn = null; }
    if (pushTurnFree(turn, Date.now())) {
      if (turn) fs.rmSync(turnFile, { force: true });
      try { fs.writeFileSync(turnFile, JSON.stringify({ card, at: Date.now() }), { flag: "wx" }); break; } catch {}
    }
    if (Date.now() > waitUntil) { console.error(`✗ 30 min se ${name} ki baari nahi aayi (${turn?.card} ${doing}). Owner ko batao.`); process.exit(4); }
    console.log(waitLine(name, card, turn?.card, doing));
    await new Promise((r) => setTimeout(r, 15000));
  }
  try { return await fn(); } finally { fs.rmSync(turnFile, { force: true }); }
}

/**
 * One type-check at a time (6 Oct night): each tsc of this repo takes ~2.6 GB; two or three at
 * once starved the local app on a 24 GB machine. Capping tsc's heap would just crash it.
 * (R-1827: the heap now has to go UP, not down — see TSC_HEAP_FLAG.)
 */
/**
 * R-1592 (18 Oct 2026): `next typegen` first — it writes .next/types (typedRoutes: the Route union
 * that <Link href>/router.push are checked against; tsconfig includes .next/types/**). Without it a
 * fresh worktree has no route types, so tsc passed a wrong href and only `next build` / the Cloud
 * Build gate (`npx next typegen && npx tsc --noEmit`) went red. Same steps as `npm run typecheck`.
 * typegen is light (~5 s warm, no build); it runs inside the heavy turn so tsc never sees half-written types.
 */
export const TSC_STEPS = ["npx next typegen", "npx tsc --noEmit -p ."];

/**
 * R-1827 (24 Oct 2026): after R-1791 tsc no longer fits Node's default ~4 GB heap — the push gate
 * died out of memory and workers re-ran it by hand with NODE_OPTIONS=--max-old-space-size=8192,
 * the same heap CI's typecheck step uses (.github/workflows/ci.yml). Every TSC_STEPS child gets it,
 * merged with any NODE_OPTIONS already set (an existing heap flag is replaced, not doubled).
 */
export const TSC_HEAP_FLAG = "--max-old-space-size=8192";
export function tscEnv(env = process.env) {
  const kept = String(env.NODE_OPTIONS ?? "").split(/\s+/).filter((o) => o && !o.startsWith("--max-old-space-size"));
  return { ...env, NODE_OPTIONS: [...kept, TSC_HEAP_FLAG].join(" ") };
}

/**
 * R-1960 (26 Oct 2026): the default type-check reuses a shared tsc build info (worker-tsc-cache.mjs) —
 * a fresh worktree no longer starts cold (525 s measured). Same `tsc --noEmit -p .`, same files, same
 * strictness: tsc re-checks every changed file and every importer whose types it affects.
 * `full: true` (`--full-tsc`) is the old cold check (`--incremental false`, no cache read or written).
 */
export function tscStepsFor({ full = false } = {}) {
  return full ? [TSC_STEPS[0], TSC_FULL_STEP] : TSC_STEPS;
}

function tscWithTurn(card, { full = false } = {}) {
  return withTurn("heavy", card, "type-check kar raha hai", async () => {
    const root = process.cwd();
    if (full) { dropBuildInfo(root); console.log("  tsc: --full-tsc — poora check, cache ke bina"); }
    for (const step of tscStepsFor({ full })) {
      /* The cache key includes the route types, so restore only after `next typegen` wrote them. */
      if (!full && step === TSC_STEPS[TSC_STEPS.length - 1]) {
        const r = restoreBuildInfo(root);
        console.log(r.restored ? `  tsc: incremental — shared cache se shuru (${r.from})`
          : `  tsc: incremental — ${r.reason === "own" ? "is worktree ki apni build info" : `in route types ka shared cache nahi (${r.reason}), is baar poora chalega`}`);
      }
      const t0 = Date.now();
      try { sh(step, tscEnv()); }
      catch (e) { console.error(`✗ ${step} fail (${((Date.now() - t0) / 1000).toFixed(1)} s):\n` + String(e.stdout ?? "").slice(0, 2000) + String(e.stderr ?? "").slice(-800)); return false; }
      console.log(`  ${step}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    }
    if (!full) { const w = saveBuildInfo(root); if (!w.saved) console.log(`  (tsc cache save nahi hua: ${w.reason})`); }
    return true;
  });
}

/**
 * R-385: the repo-scan / ratchet suites (scripts/ops/push-guard-suites.mjs) on the REBASED code.
 * 7 Oct: two pushes broke CI with tests outside the worker's own area. Returns the failed files
 * ([] = green). Runs inside the heavy turn so it never overlaps another worker's tsc.
 * vitest is started as `node node_modules/vitest/vitest.mjs` — no shell, so "(app)" paths stay intact.
 */
export function runGuardSuites(card) {
  return withTurn("heavy", card, "guard tests chala raha hai", async () => {
    const root = process.cwd();
    const missing = PUSH_GUARD_SUITES.filter((f) => !fs.existsSync(path.join(root, f)));
    const files = PUSH_GUARD_SUITES.filter((f) => !missing.includes(f));
    if (missing.length) console.log(`(guard list me ${missing.length} file nahi mili, chhodi: ${missing.join(", ")})`);
    const out = path.join(os.tmpdir(), `push-guard-${card}-${Date.now()}.json`);
    const t0 = Date.now();
    let crashed = null;
    try {
      execFileSync(process.execPath, [path.join(root, "node_modules", "vitest", "vitest.mjs"), "run", "--reporter=json", `--outputFile=${out}`, ...files],
        { cwd: root, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    } catch (e) { crashed = String(e.stderr ?? e.message ?? "").slice(-1500); }
    const ms = Date.now() - t0;
    let failed = [];
    try { failed = failedSuites(JSON.parse(fs.readFileSync(out, "utf8")), root); } catch {}
    fs.rmSync(out, { force: true });
    if (crashed && !failed.length) failed = [`(vitest fail, koi file naam nahi mila)\n${crashed}`];
    console.log(`${failed.length ? "✗" : "✓"} guard tests: ${files.length} files, ${(ms / 1000).toFixed(0)} s`);
    if (ms > PUSH_GUARD_BUDGET_MS) console.log(`(guard tests ${Math.round(ms / 1000)} s le gaye — ${PUSH_GUARD_BUDGET_MS / 1000} s se zyada; manager ko batao, list chhoti karni hai)`);
    return failed;
  });
}

async function pushWithTurn(card, ciFlags = {}) {
  /* R-1958: before the rebase (and again after it) — nothing of another card's may be undone. */
  const scope = (exit) => enforceScope(card, "commits", { lockDir: LOCK_DIR, allowOutside: ciFlags.allowOutside, cardPath: ciFlags.cardPath, exit });
  scope();
  /* R-1973: a card pushing again (e.g. --fixes-red after a red ci) is being built — back in a slot. */
  try { updateLock(card, (l) => (countsTowardCap(l) ? l : lockWorking(l))); } catch {}
  /* R-1936: SQL tests of the migrations this push changes — on the local DB, before the push turn. */
  relatedSqlGate(card, { skip: ciFlags.skipRelatedSql });
  await withTurn("push", card, "push kar raha hai", async () => {
    sh("git fetch -q anutech");
    /* R-1936: never push onto a red manager-pardeep (unless this card fixes it / owner override). */
    const gate = checkRedGate(card, { gh: realGh, fixesRed: ciFlags.fixesRed, ownerOverride: ciFlags.ownerOverride, log: appendCiLog });
    if (!gate.ok) { console.error(gate.message); process.exit(7); }
    console.log(gate.message);
    /* R-910 (10 Oct): a branch that already contains the tip needs no rebase, and a plain rebase would
       flatten a merge (staging → manager-pardeep). Otherwise --rebase-merges keeps any merge commits. */
    let upToDate = false;
    try { sh("git merge-base --is-ancestor anutech/manager-pardeep HEAD"); upToDate = true; } catch {}
    if (!upToDate) {
      try { sh("git rebase -q --rebase-merges anutech/manager-pardeep"); }
      catch { try { sh("git rebase --abort"); } catch {} console.error("✗ Rebase me CONFLICT — kisi aur ka code isi jagah badla. Ruko, owner ko batao. Khud se mat sulajhao."); process.exit(2); }
      scope((c) => { fs.rmSync(path.join(LOCK_DIR, "_push-turn.json"), { force: true }); process.exit(c); });
    }
    /* R-910: the Auth.js/gateway code imports a Prisma client that is generated, not committed. */
    if (fs.existsSync("prisma/schema.prisma")) { try { sh("npx prisma generate"); } catch (e) { console.error("✗ prisma generate fail — push nahi hua.\n" + String(e.stderr ?? e.message ?? "").slice(-800)); process.exit(1); } }
    /* R-1814: what THIS worker is pushing, read before anything else can move HEAD. */
    const plan = pushPlan(card, execFileSync("git", ["log", "--no-merges", "--format=%h %s", "anutech/manager-pardeep..HEAD"], { encoding: "utf8" })
      .split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(" "); return { sha: l.slice(0, i), subject: l.slice(i + 1) }; }));
    if (!plan.ok) { console.error(plan.message); process.exit(1); }
    if (plan.foreign.length) console.log(`(dhyan: is push me doosre card ke commit bhi hain:\n   ${plan.foreign.join("\n   ")})`);
    if (!(await tscWithTurn(card, { full: ciFlags.fullTsc }))) { console.error("✗ Rebase ke baad tsc fail — push nahi hua."); process.exit(1); }
    const failed = await runGuardSuites(card);
    if (failed.length) {
      console.error("✗ Guard test fail — push NAHI hua (repo-scan/ratchet test, shayad tumhare area ke bahar ka):");
      for (const f of failed) console.error(`   ${f}`);
      console.error(`Chalao: npx vitest run "${failed[0].split("\n")[0]}" — apni badli file theek karo (test ko dheela mat karo), phir dobara push.`);
      process.exit(5);
    }
    /* R-1430 (12 Oct): the repo is PUBLIC — scan the lines this push adds for secrets / client data.
       Prints file:line + rule only, never the value. */
    try { execFileSync(process.execPath, [path.join("scripts", "ops", "secret-scan.mjs"), "--diff", "anutech/manager-pardeep"], { stdio: "inherit" }); }
    catch { console.error("✗ secret-scan ne push roka — upar wali file:line se value hatao (env var use karo). Asli secret kabhi push hua ho to ROTATE karo."); process.exit(6); }
    /* R-816 worker (10 Oct): on a detached worktree the branch name is empty and the old command became
       `git push anutech :manager-pardeep` — a branch DELETE (GitHub protection refused it). Push HEAD. */
    sh("git push -q anutech HEAD:manager-pardeep", pushEnv("push", card));
    console.log(pushDoneLine(card, plan));
    /* R-1936: remember the sha so "worker-lock ci <CARD>" knows what to wait for. */
    let pushedSha = null;
    try { pushedSha = sh("git rev-parse HEAD").trim(); fs.writeFileSync(pushedNote(card), JSON.stringify({ card, sha: pushedSha, at: new Date().toISOString() })); } catch {}
    /* R-1973: waiting on CI frees the slot but keeps the files until ci says green/red. */
    try {
      const u = updateLock(card, (l) => lockAfterPush(l, { sha: pushedSha, at: new Date().toISOString() }));
      if (u.found) console.log(`  ${card} ab ci-wait: worker slot khaali (doosra card shuru ho sakta hai), files ka claim CI green/red tak rahega.`);
    } catch {}
    console.log(`Ab: node scripts/ops/worker-lock.mjs ci ${card}  → jo JSON aaye use card par ciCheck likho.`);
  });
}

/**
 * R-1898 (25 Oct 2026) — any member's Claude Code picks up any member's stopped card.
 * Pardeep: "kisi bhi team member ke claude code se kisi bhi team member ka ruka kaam aage badhe".
 * Half-done work lives on GitHub at anutech wip/<card lowercase>; the board card (status, claimedBy,
 * liveLog, `branch`) says where it stopped. docs/TEAM-PROTOCOL.md → "Picking up a stopped card".
 *
 *   node scripts/ops/worker-lock.mjs wip    R-197                (inside the worktree: HEAD → anutech wip/r-197)
 *   node scripts/ops/worker-lock.mjs resume R-197 <new worktree> (fetch wip/r-197, worktree w-r-197 from it)
 *   node scripts/ops/worker-lock.mjs guard-push [remote] [url]   (git pre-push hook: refs on stdin)
 *
 * `git` is injected ((args, {env}) => stdout) so tests drive these with a fake git.
 */
export const WIP_REMOTE = "anutech";
export const PUSH_MODE_ENV = "WORKER_LOCK_PUSH_MODE";
export const PUSH_CARD_ENV = "WORKER_LOCK_PUSH_CARD";

/** "R-1898" → "wip/r-1898". Only real card ids. */
export function wipBranch(card) {
  const id = String(card ?? "").trim().toUpperCase();
  if (!/^R-\d+$/.test(id)) throw new Error(`card id chahiye (jaise R-197), mila: ${card}`);
  return `wip/${id.toLowerCase()}`;
}

/** The env a push made by this script carries, so the pre-push guard knows who is pushing what. */
export function pushEnv(mode, card, env = process.env) {
  return { ...env, [PUSH_MODE_ENV]: mode, [PUSH_CARD_ENV]: String(card).toUpperCase() };
}

/**
 * wip: push the worktree HEAD to anutech wip/<card>. `branch` (optional) is what the caller asked
 * for — anything but the card's own wip branch is refused before git is touched. The lease is
 * explicit: the tip this clone last fetched/pushed ("" = must not exist yet), so a teammate's newer push to the
 * same wip branch is never overwritten silently. Returns { ok, message, branch?, sha? }.
 */
export function runWip(card, { git, branch, env = process.env } = {}) {
  let own;
  try { own = wipBranch(card); } catch (e) { return { ok: false, message: `✗ ${e.message}` }; }
  const id = String(card).toUpperCase();
  const target = branch == null ? own : String(branch).replace(/^refs\/heads\//, "");
  if (target !== own) {
    return { ok: false, message: `✗ ${id}: wip sirf ${own} par push hota hai — "${target}" mana hai (manager-pardeep/main/deploy/staging/doosre card ki branch kabhi nahi).` };
  }
  const dirty = git(["status", "--porcelain"]).trim();
  /* The lease is the wip tip THIS clone last saw (resume's fetch / our own last wip push), not a fresh
     ls-remote: if a teammate pushed the same wip branch since, GitHub has moved past it and the push is refused. */
  let remoteSha = "";
  try { remoteSha = git(["rev-parse", "--verify", "-q", `refs/remotes/${WIP_REMOTE}/${own}`]).trim(); } catch {}
  try {
    git(["push", "-q", `--force-with-lease=refs/heads/${own}:${remoteSha}`, WIP_REMOTE, `HEAD:refs/heads/${own}`], { env: pushEnv("wip", id, env) });
  } catch (e) {
    return { ok: false, message: `✗ ${id}: ${own} push nahi hua — GitHub par kisi ne isi branch par naya push kiya (lease) ya network. git fetch ${WIP_REMOTE} karke dekho; zabardasti mat karo.\n${String(e?.stderr ?? e?.message ?? e).slice(-600)}` };
  }
  const sha = git(["rev-parse", "--short", "HEAD"]).trim();
  const lines = [
    `✓ ${id} WIP GitHub par: ${WIP_REMOTE}/${own} @ ${sha}${remoteSha ? "" : " (nayi branch)"}`,
    `  Card par likho (ArtifactData update): "branch": "${own}" + liveLog "done …; next …; branch ${own}".`,
  ];
  if (dirty) lines.push(`  (dhyan: bina commit ki badli files push NAHI hui — pehle "WIP ${id}: …" commit karo, phir wip dobara.)`);
  return { ok: true, branch: own, sha, message: lines.join("\n") };
}

/**
 * resume: fetch anutech wip/<card> and build a NEW worktree (branch w-<card>) from it.
 * `exists` is injected (fs.existsSync in the CLI). Returns { ok, message }.
 */
export function runResume(card, worktree, { git, exists }) {
  let own;
  try { own = wipBranch(card); } catch (e) { return { ok: false, message: `✗ ${e.message}` }; }
  const id = String(card).toUpperCase();
  if (!worktree) return { ok: false, message: `resume ${id} <naya worktree folder>   (jaise C:/Users/<you>/reselleros-w-${id.toLowerCase()})` };
  if (exists(worktree)) return { ok: false, message: `✗ ${worktree} pehle se hai — naya folder do (ya wahi worktree hai to usme git pull karo).` };
  try { git(["fetch", "-q", WIP_REMOTE, `+refs/heads/${own}:refs/remotes/${WIP_REMOTE}/${own}`]); }
  catch { return { ok: false, message: `✗ ${id}: GitHub par ${WIP_REMOTE}/${own} nahi mili — uthane ko WIP nahi. Card ka liveLog dekho; naya kaam ${WIP_REMOTE}/manager-pardeep se shuru karo.` }; }
  const local = `w-${id.toLowerCase()}`;
  try { git(["worktree", "add", worktree, "-b", local, `${WIP_REMOTE}/${own}`]); }
  catch (e) { return { ok: false, message: `✗ worktree nahi bana (branch ${local} pehle se? \`git branch -D ${local}\` sirf tab jab wo khaali ho):\n${String(e?.stderr ?? e?.message ?? e).slice(-600)}` }; }
  const last = git(["log", "-1", "--format=%h %s", `${WIP_REMOTE}/${own}`]).trim();
  return {
    ok: true,
    message: [
      `✓ ${id} uthaya: ${worktree} (branch ${local}) ← ${WIP_REMOTE}/${own} @ ${last}`,
      "Ab:",
      `  1. Board: card ${id} → status doing, claimedBy = tumhara naam, claimedAt (date -u), liveLog "picked up from <pichhla claimedBy> — <kahan ruka tha>; next …".`,
      "  2. node_modules junction/symlink + production/.env.local copy + npx prisma generate (docs/WORKER-STEPS.md step 1).",
      `  3. production/ se: node scripts/ops/worker-lock.mjs claim ${id} ${worktree} <files>... --card <card.json>`,
      `  4. Card ke aakhri liveLog ka "next" se aage; har green step par commit + wip ${id}; aakhir me sirf push ${id}.`,
    ].join("\n"),
  };
}

/**
 * Pre-push guard, pure: `lines` = git pre-push stdin ("<local ref> <local sha> <remote ref> <remote sha>").
 * wip/* only from `wip` and only to that card's own branch; manager-pardeep only from `push`.
 * Other refs are not this guard's business. Returns { ok, message }.
 */
export function guardPush(lines, env = process.env) {
  const mode = env[PUSH_MODE_ENV] || "";
  const card = env[PUSH_CARD_ENV] || "";
  const bad = [];
  for (const raw of lines) {
    const parts = String(raw).trim().split(/\s+/);
    if (parts.length < 4) continue;
    const ref = parts[2].replace(/^refs\/heads\//, "");
    if (ref.startsWith("wip/")) {
      let own = null; try { own = wipBranch(card); } catch {}
      if (mode !== "wip" || ref !== own) bad.push(`${ref} — wip branch sirf "worker-lock.mjs wip <CARD>" se, aur sirf us card ki apni (${own ?? "koi card nahi"})`);
    } else if (ref === "manager-pardeep" && mode !== "push") {
      bad.push(`${ref} — sirf "worker-lock.mjs push <CARD>" se`);
    }
  }
  if (bad.length) return { ok: false, message: "✗ push guard ne roka:\n   " + bad.join("\n   ") };
  return { ok: true, message: "" };
}

/**
 * R-1936 (25 Oct 2026) — stop the line on red CI (G-PROCESS recommendation #2).
 * 12–25 Oct: CI was red 26% and SQL tests 23% of the time, red stretches up to 24 h, and new pushes
 * kept landing on a red manager-pardeep. Three rules:
 *
 *   push  — before pushing, the newest finished "CI" and "SQL tests" runs on manager-pardeep must not
 *           be red. Red → refuse ("CI laal hai … pehle woh theek karo"). `--fixes-red` (the card that
 *           fixes it) and `--owner-override` pass, and both are logged. A run still going does not
 *           block. gh missing/offline → warn and continue: a tool failure never blocks a push.
 *   push  — when the push changes supabase/migrations/*.sql, the SQL tests that mention a function /
 *           table / view those migrations create run first on the LOCAL DB (migration + test in one
 *           rolled-back transaction). One red → no push. Local DB down → warn and skip.
 *   ci    — after the push: wait for this sha's "CI" and "SQL tests" runs, print green/red with the
 *           failing test names, and a one-line JSON the worker writes as `ciCheck` on the card.
 *           Exit 0 green, 7 red, 8 timeout / could not tell.
 *
 *   node scripts/ops/worker-lock.mjs push R-197 --card c.json [--fixes-red | --owner-override] [--skip-related-sql]
 *   node scripts/ops/worker-lock.mjs ci   R-197 [--sha <sha>] [--timeout-min 25]
 *   node scripts/ops/worker-lock.mjs sql-related R-197
 *
 * gh / git / psql are injected so tests drive every rule with fakes.
 */
export const CI_REPO = "Anutech-Digital/anutechbilling";
export const CI_BRANCH = "manager-pardeep";
export const GATE_WORKFLOWS = ["CI", "SQL tests"];
/** Conclusions that mean "the branch is broken". cancelled/skipped/neutral = superseded, not red. */
export const RED_CONCLUSIONS = ["failure", "timed_out", "startup_failure", "action_required"];
const SKIP_CONCLUSIONS = ["cancelled", "skipped", "neutral", "stale"];
export const CI_EXIT = { green: 0, red: 7, timeout: 8 };
const RUN_FIELDS = "databaseId,workflowName,status,conclusion,headSha,url,createdAt";

/** Pull the R-1936 flags out of the positional args. */
export function parseCiFlags(args) {
  const rest = []; const f = { fixesRed: false, ownerOverride: false, skipRelatedSql: false, sha: null, timeoutMin: 25 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--fixes-red") f.fixesRed = true;
    else if (a === "--owner-override") f.ownerOverride = true;
    else if (a === "--skip-related-sql") f.skipRelatedSql = true;
    else if (a === "--sha") f.sha = args[++i] ?? null;
    else if (a.startsWith("--sha=")) f.sha = a.slice(6);
    else if (a === "--timeout-min") f.timeoutMin = Number(args[++i]);
    else if (a.startsWith("--timeout-min=")) f.timeoutMin = Number(a.slice(14));
    else rest.push(a);
  }
  if (!Number.isFinite(f.timeoutMin) || f.timeoutMin <= 0) f.timeoutMin = 25;
  return { rest, ...f };
}

function newestFirst(runs) {
  return [...runs].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

/**
 * The branch's state per gate workflow, from `gh run list -b manager-pardeep` rows. Newest first;
 * cancelled/skipped runs are passed over (a newer push superseded them). The first run that is still
 * going → "running" (does not block); the first finished run → "green" or "red".
 */
export function branchGateState(runs) {
  const out = {};
  for (const wf of GATE_WORKFLOWS) {
    out[wf] = { state: "none" };
    for (const r of newestFirst(runs.filter((x) => x.workflowName === wf))) {
      if (r.status !== "completed") { out[wf] = { state: "running", run: r }; break; }
      if (SKIP_CONCLUSIONS.includes(r.conclusion)) continue;
      out[wf] = { state: RED_CONCLUSIONS.includes(r.conclusion) ? "red" : "green", run: r };
      break;
    }
  }
  return out;
}

/** Failing test names from `gh run view --log-failed`: vitest " FAIL  tests/x.test.ts > …" and test-sql " FAIL [21/300] name". */
export function failingTestNames(log, max = 8) {
  const names = [];
  for (const raw of String(log ?? "").split(/\r?\n/)) {
    const content = raw.split("\t").pop().replace(/\x1b\[[0-9;]*m/g, "").replace(/^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "");
    const m = /^\s*FAIL\s+(?:\[\d+\/\d+\]\s+)?(\S.*?)\s*$/.exec(content);
    /* ratchet / guard summaries: "Lint ratchet FAILED — more warnings than baseline for: max-lines" */
    const r = m ? null : /^\s*(\S.*\bFAILED\s+—.*?)\s*$/.exec(content);
    const name = m?.[1] ?? r?.[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names.length > max ? [...names.slice(0, max), `… +${names.length - max} aur`] : names;
}

/** Failed steps from `gh run view --json jobs`: ["checks › Run npm run lint:ratchet"]. */
export function failingSteps(jobsJson) {
  const jobs = jobsJson && Array.isArray(jobsJson.jobs) ? jobsJson.jobs : [];
  return jobs.flatMap((j) => (j.steps ?? []).filter((st) => RED_CONCLUSIONS.includes(st.conclusion)).map((st) => `${j.name} › ${st.name}`));
}

function failedTestsOf(gh, run) {
  let n = [];
  try { n = failingTestNames(gh(["run", "view", String(run.databaseId), "-R", CI_REPO, "--log-failed"])); } catch {}
  if (n.length) return n;
  try { n = failingSteps(JSON.parse(gh(["run", "view", String(run.databaseId), "-R", CI_REPO, "--json", "jobs"]))); } catch {}
  return n.length ? n.map((x) => `step: ${x}`) : ["(test ka naam log me nahi mila — " + run.url + ")"];
}

/** gh as a function: (args) => stdout. Throws when gh is missing / offline / not logged in. */
export function realGh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
}

/**
 * The red-branch gate inside `push`. Returns { ok, message, warn?, logged? }. Never throws: any gh
 * failure → ok with a warning. `log` (line) => void records an override/fixes-red pass.
 */
export function checkRedGate(card, { gh, fixesRed = false, ownerOverride = false, log = () => {} } = {}) {
  const id = String(card).toUpperCase();
  let runs;
  try { runs = JSON.parse(gh(["run", "list", "-R", CI_REPO, "-b", CI_BRANCH, "-L", "40", "--json", RUN_FIELDS])); }
  catch (e) {
    return { ok: true, warn: true, message: `⚠ ${id}: GitHub CI ka haal nahi mila (gh nahi chala: ${String(e?.message ?? e).split("\n")[0].slice(0, 160)}) — CI-laal jaanch chhodi, push aage. Push ke baad "worker-lock ci ${id}" zaroor chalao.` };
  }
  const state = branchGateState(Array.isArray(runs) ? runs : []);
  const red = GATE_WORKFLOWS.filter((wf) => state[wf].state === "red").map((wf) => ({ workflow: wf, run: state[wf].run }));
  const running = GATE_WORKFLOWS.filter((wf) => state[wf].state === "running");
  const note = running.length ? ` (${running.join(" + ")} abhi chal raha hai — rokta nahi)` : "";
  if (!red.length) return { ok: true, message: `✓ ${CI_BRANCH} par CI laal nahi${note}.` };
  const parts = red.map(({ workflow, run }) => `${workflow} on ${String(run.headSha).slice(0, 8)}: ${failedTestsOf(gh, run).join(", ")}`);
  const what = parts.join("; ");
  if (fixesRed || ownerOverride) {
    const how = fixesRed ? "--fixes-red" : "--owner-override";
    const line = JSON.stringify({ at: new Date().toISOString(), card: id, how, red: what });
    try { log(line); } catch {}
    return { ok: true, logged: line, message: `⚠ CI laal hai (${what}) — ${id} ${how} se aage badh raha hai (log me likha). ${fixesRed ? "Push ke baad 'worker-lock ci' se dekho ki hara hua." : "Card ke liveLog me override likho."}` };
  }
  return {
    ok: false,
    message: `✗ CI laal hai (${what}) — pehle woh theek karo.\n` +
      red.map(({ workflow, run }) => `   ${workflow}: ${run.url}`).join("\n") +
      `\n   Ye card hi laal ko theek karta hai → push ${id} … --fixes-red. Owner ne kaha "phir bhi push karo" → --owner-override (log hota hai).`,
  };
}

/**
 * Verdict for one workflow from the runs for this sha. `later` = newer runs on the branch whose sha
 * CONTAINS ours (oldest first): when our run was cancelled by the next push, that run decides.
 * Returns { state: green|red|pending|skipped|missing, run? , via? }.
 */
export function workflowVerdict(wf, shaRuns, later, { graceOver, ciDone }) {
  const mine = newestFirst(shaRuns.filter((r) => r.workflowName === wf));
  const pick = (r) => (r.status !== "completed" ? "pending" : RED_CONCLUSIONS.includes(r.conclusion) ? "red" : r.conclusion === "success" ? "green" : null);
  for (const r of mine) { const s = pick(r); if (s) return { state: s, run: r }; }
  if (mine.length || graceOver) {
    for (const r of later.filter((x) => x.workflowName === wf)) { const s = pick(r); if (s) return { state: s, run: r, via: r.headSha }; }
  }
  if (!mine.length) {
    /* SQL tests run only when production/supabase/** changed — none for this sha = nothing to test. */
    if (wf === "SQL tests" && (ciDone || graceOver)) return { state: "skipped" };
    return graceOver ? { state: "missing" } : { state: "pending" };
  }
  return graceOver ? { state: "missing", run: mine[0] } : { state: "pending", run: mine[0] }; // all cancelled, nothing later yet
}

/** The last sha pushed for this card: the lock dir note `push` writes, else the newest "<CARD>:" commit on the branch. */
export function lastPushedSha(card, { git, readNote = () => null } = {}) {
  const id = String(card).toUpperCase();
  try { const n = readNote(id); if (n?.sha) return n.sha; } catch {}
  try {
    const s = git(["log", `anutech/${CI_BRANCH}`, "-1", "--format=%H", "-E", `--grep=^${id}:`]).trim();
    if (s) return s;
  } catch {}
  return null;
}

/**
 * `ci <CARD>`: poll until both gate workflows have a verdict for the sha, or the timeout.
 * deps: gh, git, isAncestor(a, b), now(), sleep(ms), print(line). Returns { code, check, lines }.
 */
export async function runCi(card, { gh, git, isAncestor, sha, timeoutMin = 25, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), print = () => {}, readNote, pollMs = 30_000, graceMs = 3 * 60_000 } = {}) {
  const id = String(card).toUpperCase();
  const target = sha || lastPushedSha(id, { git, readNote });
  const finish = (code, check, extra = []) => ({ code, check, lines: extra });
  if (!target) return finish(CI_EXIT.timeout, null, [`✗ ${id}: is card ka push kiya sha nahi mila — --sha <sha> do.`]);
  let full = target;
  try { full = git(["rev-parse", target]).trim() || target; } catch {}
  const t0 = now();
  const deadline = t0 + timeoutMin * 60_000;
  let lastErr = null;
  for (;;) {
    let shaRuns = null, branchRuns = [];
    try {
      shaRuns = JSON.parse(gh(["run", "list", "-R", CI_REPO, "--commit", full, "-L", "20", "--json", RUN_FIELDS]));
      branchRuns = JSON.parse(gh(["run", "list", "-R", CI_REPO, "-b", CI_BRANCH, "-L", "40", "--json", RUN_FIELDS]));
      lastErr = null;
    } catch (e) { lastErr = String(e?.message ?? e).split("\n")[0].slice(0, 200); }
    if (shaRuns) {
      const later = newestFirst(branchRuns).reverse()
        .filter((r) => r.headSha !== full && !shaRuns.some((m) => m.databaseId === r.databaseId))
        .filter((r) => { try { return isAncestor(full, r.headSha); } catch { return false; } });
      const graceOver = now() - t0 >= graceMs;
      const ci = workflowVerdict("CI", shaRuns, later, { graceOver, ciDone: false });
      const sql = workflowVerdict("SQL tests", shaRuns, later, { graceOver, ciDone: ci.state === "green" || ci.state === "red" });
      const settled = (v) => v.state !== "pending";
      const timedOut = now() >= deadline;
      if ((settled(ci) && settled(sql)) || timedOut) {
        const runUrls = [ci.run?.url, sql.run?.url].filter(Boolean);
        const check = { sha: full, ci: ci.state, sql: sql.state, at: new Date(now()).toISOString().replace(/\.\d{3}Z$/, "Z"), runUrls };
        if (ci.via || sql.via) check.via = (ci.via || sql.via);
        const lines = [];
        const icon = (s) => (s === "green" ? "✓" : s === "skipped" ? "–" : s === "red" ? "✗" : "…");
        lines.push(`${id} @ ${full.slice(0, 8)}: CI ${icon(ci.state)} ${ci.state} · SQL ${icon(sql.state)} ${sql.state}${check.via ? ` (apna run cancel hua; ${check.via.slice(0, 8)} wala run dekha jisme ye sha hai)` : ""}`);
        for (const [wf, v] of [["CI", ci], ["SQL tests", sql]]) {
          if (v.state === "red") { const names = failedTestsOf(gh, v.run); check[wf === "CI" ? "ciFailed" : "sqlFailed"] = names; lines.push(`  ✗ ${wf} laal: ${names.join(", ")}\n    ${v.run.url}`); }
        }
        const red = ci.state === "red" || sql.state === "red";
        const green = ci.state === "green" && (sql.state === "green" || sql.state === "skipped");
        if (!red && !green) lines.push(`  ✗ ${timedOut ? `${timeoutMin} min me faisla nahi hua` : "run nahi mila"} — thodi der baad dobara: worker-lock ci ${id} --sha ${full.slice(0, 12)}`);
        else if (red) lines.push(`  CI laal — fixing it comes first (card ${id} ke liveLog me likho; theek karne wala push --fixes-red ke saath).`);
        lines.push(`  Card par ciCheck likho: ${JSON.stringify(check)}`);
        return finish(red ? CI_EXIT.red : green ? CI_EXIT.green : CI_EXIT.timeout, check, lines);
      }
      print(`… ${id}: CI ${ci.state} · SQL ${sql.state} — ${Math.round((now() - t0) / 60000)} min`);
    } else if (now() >= deadline) {
      return finish(CI_EXIT.timeout, null, [`✗ ${id}: gh se CI ka haal nahi mila (${lastErr}). gh auth status / network dekho.`]);
    } else {
      print(`… ${id}: gh nahi chala (${lastErr}) — dobara koshish`);
    }
    await sleep(pollMs);
  }
}

/* ── Related SQL tests before the push ───────────────────────────────────────────────────── */

/** Functions / tables / views a migration creates or replaces (lower case, no schema). */
export function migrationDefines(sql) {
  const names = new Set();
  const src = String(sql ?? "").replace(/--[^\n]*/g, "");
  const id = String.raw`(?:"?[a-z_][a-z0-9_]*"?\.)?"?([a-z_][a-z0-9_]*)"?`;
  const res = [
    new RegExp(String.raw`create\s+(?:or\s+replace\s+)?function\s+${id}`, "gi"),
    new RegExp(String.raw`create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?${id}`, "gi"),
    new RegExp(String.raw`create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?${id}`, "gi"),
  ];
  for (const re of res) for (const m of src.matchAll(re)) names.add(m[1].toLowerCase());
  return [...names];
}

/** The test files (of [{file, src}]) that mention any of the names as a whole word. */
export function relatedSqlTests(names, tests) {
  if (!names.length) return [];
  const res = names.map((n) => new RegExp(String.raw`(^|[^a-z0-9_])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9_]|$)`, "i"));
  return tests.filter((t) => res.some((re) => re.test(t.src))).map((t) => ({ ...t, hits: names.filter((n, i) => res[i].test(t.src)) }));
}

/** First-line `-- deploy-peek: <SQL boolean>` of a migration, or null. */
export function deployPeek(sql) {
  const m = /^\s*--\s*deploy-peek:\s*(.+)$/m.exec(String(sql ?? "").split("\n").slice(0, 3).join("\n"));
  return m ? m[1].trim() : null;
}

/** Same safety rule as scripts/test-sql.mjs: ends in rollback, never commits. */
export function sqlTestSafe(src) {
  return /^\s*rollback\s*;/im.test(src) && !/^\s*commit\s*;/im.test(src);
}

/** One script: begin; the not-yet-applied migrations (their own begin;/commit; lines dropped); the test (ends in rollback). */
export function relatedTestScript(pendingMigrations, testSrc) {
  const mig = pendingMigrations.map((m) => `-- migration ${m.file}\n` + m.src.replace(/^\s*(begin|commit)\s*;\s*$/gim, "-- ($1 dropped: one rolled-back transaction)")).join("\n\n");
  return `begin;\n${mig}\n\n${testSrc}\n`;
}

/**
 * Run the SQL tests related to the changed migrations on the LOCAL DB. deps:
 *   changed: [{file, src}] migrations this push adds/changes; tests: [{file, src}] supabase/tests/*.sql;
 *   psql(sql) => {status, out} (null when no local DB).
 * Returns { ok, skipped?, ran: [{file, ok, why?}], message }.
 */
export function runRelatedSql({ changed, tests, psql }) {
  if (!changed.length) return { ok: true, skipped: true, ran: [], message: "(koi migration nahi badli — related SQL tests nahi)" };
  const names = [...new Set(changed.flatMap((m) => migrationDefines(m.src)))];
  const related = relatedSqlTests(names, tests);
  if (!related.length) return { ok: true, skipped: true, ran: [], message: `(badli migrations [${names.join(", ") || "kuch nahi banaya"}] ka koi SQL test nahi mila)` };
  if (!psql) return { ok: true, skipped: true, ran: [], message: `⚠ local DB nahi chal raha — ${related.length} related SQL test chhode (${related.map((t) => t.file).join(", ")}). CI ka "SQL tests" dekhna.` };
  if (changed.some((m) => /\bconcurrently\b/i.test(m.src.replace(/--[^\n]*/g, "")))) {
    return { ok: true, skipped: true, ran: [], message: "⚠ migration me CONCURRENTLY hai (transaction me nahi chalta) — related SQL tests chhode; CI dekhna." };
  }
  /* A migration whose deploy-peek is already true on the local DB is applied — run the test on top of it. */
  const pending = [];
  for (const m of changed) {
    const peek = deployPeek(m.src);
    let applied = false;
    if (peek) { const r = psql(`select case when (${peek}) then 'PEEK_APPLIED' else 'PEEK_PENDING' end;`); applied = r.status === 0 && /PEEK_APPLIED/.test(r.out); }
    if (!applied) pending.push(m);
  }
  const ran = [];
  for (const t of related) {
    if (!sqlTestSafe(t.src)) { ran.push({ file: t.file, ok: false, why: "rollback se khatam nahi hoti / commit karti hai (CI ka runner bhi mana karega)" }); continue; }
    const r = psql(relatedTestScript(pending, t.src));
    if (r.status === 0) { ran.push({ file: t.file, ok: true }); continue; }
    const why = (String(r.out).match(/ERROR:[^\n]{0,300}/g) ?? [String(r.out).slice(-300)]).slice(0, 3).join(" | ");
    /* Red WITH the new migration but also red WITHOUT it = the local DB was already broken for this test
       (leftover rows, a missing older migration) — not this push's doing. Warn, don't block; CI decides. */
    if (pending.length && psql(relatedTestScript([], t.src)).status !== 0) { ran.push({ file: t.file, ok: true, localRed: true, why }); continue; }
    ran.push({ file: t.file, ok: false, why });
  }
  const bad = ran.filter((x) => !x.ok);
  const localRed = ran.filter((x) => x.localRed);
  const head = `related SQL tests (${names.join(", ")}): ${ran.length - bad.length - localRed.length}/${ran.length} hare` + (pending.length ? `, ${pending.length} nayi migration ke saath (rollback)` : "");
  return {
    ok: !bad.length, ran,
    message: (bad.length ? "✗ " : "✓ ") + head +
      localRed.map((b) => `\n   ⚠ ${b.file}: migration ke bina bhi local DB par laal (local DB ki purani gadbad, is push ki nahi) — ${b.why}`).join("") +
      bad.map((b) => `\n   ✗ ${b.file}: ${b.why}`).join("") +
      (bad.length && !pending.length ? "\n   (migration local DB par pehle se lagi hai. Agar ye test migration ke bina bhi laal tha — local DB ki purani gadbad — to owner se poochh kar --skip-related-sql, log hota hai.)" : ""),
  };
}

/** Real deps for runRelatedSql, from the worktree's production/ folder. */
function relatedSqlDeps() {
  const base = execSync(`git merge-base HEAD anutech/${CI_BRANCH}`, { encoding: "utf8" }).trim();
  const files = execFileSync("git", ["diff", "--name-only", "--diff-filter=AM", base, "HEAD", "--", "supabase/migrations"], { encoding: "utf8" })
    .split("\n").map((s) => s.trim()).filter((s) => /\.sql$/.test(s));
  const top = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  const changed = files.map((f) => ({ file: path.basename(f), src: fs.readFileSync(path.join(top, f), "utf8") }));
  const dir = path.join("supabase", "tests");
  const tests = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => ({ file: f, src: fs.readFileSync(path.join(dir, f), "utf8") })) : [];
  let psql = null;
  if (changed.length) {
    try {
      const container = execFileSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 })
        .split(/\r?\n/).map((s) => s.trim()).find((n) => /^supabase_db_/.test(n));
      if (container) {
        psql = (sql) => {
          const r = spawnSync("docker", ["exec", "-i", container, "psql", "-v", "ON_ERROR_STOP=1", "-tA", "-U", "postgres", "-d", "postgres"], { input: sql, encoding: "utf8", timeout: 120_000 });
          return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
        };
      }
    } catch { psql = null; }
  }
  return { changed, tests, psql };
}

function relatedSqlGate(card, { skip = false } = {}) {
  if (skip) { appendCiLog({ at: new Date().toISOString(), card, how: "--skip-related-sql" }); console.log("⚠ --skip-related-sql: related SQL tests chhode (log me likha)."); return; }
  let r;
  try { r = runRelatedSql(relatedSqlDeps()); }
  catch (e) { console.log(`⚠ related SQL tests nahi chal paaye (${String(e?.message ?? e).split("\n")[0].slice(0, 200)}) — chhode, CI dekhna.`); return; }
  if (r.ok) { console.log(r.message); return; }
  console.error(r.message);
  console.error(`✗ ${card}: badli migration ka SQL test laal — push NAHI hua. Theek karo (test dheela mat karo), phir dobara push.`);
  process.exit(5);
}

export const CI_LOG = () => path.join(LOCK_DIR, "_ci-gate.log");
function appendCiLog(obj) { try { fs.appendFileSync(CI_LOG(), (typeof obj === "string" ? obj : JSON.stringify(obj)) + "\n"); } catch {} }
const pushedNote = (card) => path.join(LOCK_DIR, `_pushed-${String(card).toUpperCase()}.json`);
function readPushedNote(card) { try { return JSON.parse(fs.readFileSync(pushedNote(card), "utf8")); } catch { return null; } }

/** "export { default } from '../leads/page'" → "../leads/page"; null when the file has real code. */
export function reexportTarget(src) {
  const lines = String(src).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//") && !l.startsWith("/*") && !l.startsWith("*"));
  if (!lines.length || lines.length > 3) return null;
  const m = lines.map((l) => l.match(/^export\s+(?:\{[^}]*\}|\*)\s+from\s+["']([^"']+)["']/)).find(Boolean);
  return m && lines.every((l) => /^export\s/.test(l) || /^import\s/.test(l)) ? m[1] : null;
}

/** Lock area for a path: its folder for a file under src/app or src/lib, else the file itself. */
export function lockAreaFor(p) {
  const n = normPath(p);
  if (/\.[a-z]+$/i.test(n) && /^src\/(app|lib)\//.test(n)) { const d = n.split("/").slice(0, -1).join("/"); return tooBroad(d) ? n : d; }
  return n;
}

function prep(card, paths) {
  const root = process.cwd().replace(/\\/g, "/").endsWith("/production") ? process.cwd() : path.join(process.cwd(), "production");
  let missing = 0; const areas = new Set();
  for (const raw of paths) {
    const n = normPath(raw); const full = path.join(root, n);
    if (!fs.existsSync(full)) { console.log(`✗ ${n} — NAHI MILA`); missing++; continue; }
    let real = n;
    if (fs.statSync(full).isFile()) {
      const t = reexportTarget(fs.readFileSync(full, "utf8"));
      if (t) {
        const base = t.startsWith("@/") ? path.join(root, "src", t.slice(2)) : path.resolve(path.dirname(full), t);
        const hit = [".tsx", ".ts", "/page.tsx", "/index.ts", ""].map((e) => base + e).find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
        if (hit) { real = normPath(path.relative(root, hit)); console.log(`↪ ${n} sirf re-export hai — asli code: ${real}`); }
      }
    }
    if (real === n) console.log(`✓ ${n}`);
    areas.add(lockAreaFor(real)); if (real !== n) areas.add(lockAreaFor(n));
  }
  console.log(`\nlockAreas (card par likho): ${JSON.stringify([...areas])}`);
  if (missing) { console.error(`✗ ${card}: ${missing} path nahi mile — card theek karo, tab worker ko do.`); process.exit(1); }
  console.log(`✓ ${card} taiyaar — card par prepared: true likho.`);
}

/** R-842: board v76 card contract. Fields a card must have before a worker may claim it. */
export const CLAIM_FIELDS = ["triage.verdict", "triage.why", "triage.at", "kind", "category", "doneWhen"];
/** Before the finishing push. (`commits` is written right after the push — the sha does not exist before it.) */
export const PUSH_FIELDS = ["howToCheck"];

function filled(v) {
  if (v == null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** Missing contract fields (dotted names) for "claim" or "push"; [] = card is fine. */
export function cardContractGaps(card, stage) {
  const need = stage === "push" ? PUSH_FIELDS : CLAIM_FIELDS;
  const c = card && typeof card === "object" ? card : {};
  return need.filter((f) => !filled(f.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), c)));
}

/** Only manager cards (R-900…R-999) may skip the card check. */
export function managerCard(card) { return /^R-9\d\d$/i.test(String(card)); }

/** Pull --card <path> / --card=<path> / --no-card-check out of the args; the rest stay positional. */
export function parseCardFlags(args) {
  const rest = []; let cardPath = null; let noCheck = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--no-card-check") noCheck = true;
    else if (a === "--card") cardPath = args[++i] ?? "";
    else if (a.startsWith("--card=")) cardPath = a.slice("--card=".length);
    else rest.push(a);
  }
  return { rest, cardPath, noCheck };
}

/** Accepts the ArtifactData out_dir file (plain card fields) or a {id, data: {...}} wrapper. */
export function cardFromJson(obj) {
  if (obj && typeof obj === "object" && obj.data && typeof obj.data === "object" && !("doneWhen" in obj) && !("title" in obj)) return { id: obj.id, ...obj.data };
  return obj;
}

/**
 * The guard, pure so tests can drive it: { ok, message }. `readFile` is injected (fs in the CLI).
 * Refuses: no --card (unless R-9xx + --no-card-check), unreadable JSON, a card file for another id,
 * or missing contract fields.
 */
export function checkCardContract(cardId, stage, { cardPath, noCheck }, readFile = (p) => fs.readFileSync(p, "utf8")) {
  const id = String(cardId).toUpperCase();
  if (noCheck) {
    if (managerCard(id)) return { ok: true, message: `(${id}: manager card — card contract check skipped)` };
    return { ok: false, message: `✗ --no-card-check sirf R-9xx manager cards ke liye hai. ${id} ke liye --card <card.json> do.` };
  }
  if (!cardPath) {
    return { ok: false, message: `✗ ${id}: --card <file> do. Pehle ArtifactData get (collection cards, doc_id ${id}, out_dir <folder>) se card save karo, phir: ${stage} ${id} … --card <folder>/cards/${id}.json` + (managerCard(id) ? " (R-9xx manager card: --no-card-check bhi chalega)" : "") };
  }
  let card;
  try { card = cardFromJson(JSON.parse(readFile(cardPath))); }
  catch (e) { return { ok: false, message: `✗ ${id}: card file padh nahi paaya (${cardPath}): ${String(e?.message ?? e).slice(0, 200)}` }; }
  if (card && card.id && String(card.id).toUpperCase() !== id) return { ok: false, message: `✗ --card file ${card.id} ki hai, ${id} ki nahi.` };
  const gaps = cardContractGaps(card, stage);
  if (gaps.length) {
    const when = stage === "push" ? "push (card band) se pehle" : "claim se pehle";
    return { ok: false, message: `✗ ${id}: card contract (board v76) adhoora — ${when} ye field chahiye: ${gaps.join(", ")}.\n   Card par likho, card dobara save karo (ArtifactData get out_dir), phir chalao. Bina field ke card mat chalao.` };
  }
  return { ok: true, message: `✓ ${id}: card contract theek (${stage}).` };
}

function enforceCard(card, stage, flags) {
  const r = checkCardContract(card, stage, flags);
  if (!r.ok) { console.error(r.message); process.exit(6); }
  console.log(r.message);
}

function main(argv) {
  const [cmd, rawCard, ...args] = argv;
  const card = rawCard?.toUpperCase();
  const { rest: scopeRest, allowOutside } = parseScopeFlags(args);
  const { rest, ...cardFlags } = parseCardFlags(scopeRest);
  fs.mkdirSync(LOCK_DIR, { recursive: true });

  if (cmd === "list") {
    const locks = readLocks();
    if (!locks.length) return console.log("Koi worker lock nahi.");
    for (const l of locks) console.log(`${l.card}  ${l.state ?? LOCK_STATES.working}${countsTowardCap(l) ? "" : " (slot nahi ginta)"}  ${l.claimedAt}  ${[...l.areas, ...(l.files ?? [])].join("  ")}`);
    return;
  }
  if (cmd === "guard-push") {
    /* R-1898: git pre-push hook — the refs come on stdin. */
    const r = guardPush(fs.readFileSync(0, "utf8").split("\n"));
    if (!r.ok) { console.error(r.message); process.exit(1); }
    return;
  }
  if (!card || !/^R-\d+$/.test(card)) { console.error("Card id do, jaise R-197"); process.exit(1); }

  if (cmd === "claim") {
    const { rest: claimArgs, fixesRed } = parseCiFlags(rest);
    const [worktree, ...areas] = claimArgs;
    const locks = readLocks();
    const own = locks.find((l) => l.card === card) ?? null;
    /* R-1973: `claim <CARD> --fixes-red` (no paths) = take the slot back for a card in ci-wait / ci-red. */
    const reclaim = fixesRed && own && !countsTowardCap(own) && !worktree;
    if (!reclaim && (!worktree || !areas.length)) { console.error("claim <CARD> <worktree> <folder/file>... --card <card.json>   (CI laal ke baad: claim <CARD> --fixes-red --card <card.json>)"); process.exit(1); }
    enforceCard(card, "claim", cardFlags);
    const broad = areas.filter(tooBroad);
    if (broad.length) { console.error(`✗ Bahut bada area: ${broad.join(", ")} — page/lib ka folder ya file do (kam se kam 3 hisse, jaise src/lib/deals).`); process.exit(1); }
    const slot = claimSlot(card, locks, { fixesRed });
    if (!slot.ok) {
      const busy = locks.filter((l) => l.card !== card && countsTowardCap(l)).map((l) => l.card);
      const waiting = locks.filter((l) => l.card !== card && !countsTowardCap(l)).map((l) => `${l.card} ${l.state}`);
      console.error(`✗ PEHLE SE ${maxWorkersAt(Date.now())} WORKER chal rahe hain (${busy.join(", ")})${waiting.length ? ` — CI ka intezaar slot nahi ginta: ${waiting.join(", ")}` : ""} — computer hang na ho, isliye ruko.`);
      console.error("Owner ko batao: \"Ek worker khatam hone ke baad ye card chalaiye.\" Lock ko haath mat lagao.");
      process.exit(3);
    }
    if (slot.overCap) console.log(`(${card} --fixes-red: CI laal theek karna pehle — cap bhara hone par bhi slot wapas diya)`);
    if (reclaim) {
      updateLock(card, lockWorking);
      console.log(`✓ ${card} ne slot wapas liya (${own.state} → working); files wahi: ${[...(own.areas ?? []), ...(own.files ?? [])].join(", ")}`);
      return;
    }
    const conflicts = findConflicts(card, areas, locks);
    if (conflicts.length) report(conflicts);
    /* A re-claim keeps what the card already holds (its ci-wait files stay claimed). */
    const keep = own ? [...(own.areas ?? [])] : [];
    fs.writeFileSync(lockFile(card), JSON.stringify({ card, worktree: path.resolve(worktree), areas: [...new Set([...keep, ...areas.map(normPath)])], files: own?.files ?? [], claimedAt: own?.claimedAt ?? new Date().toISOString(), state: LOCK_STATES.working }, null, 2));
    console.log(`✓ ${card} ka lock laga: ${areas.map(normPath).join(", ")}`);
    return;
  }
  if (cmd === "check") {
    const f = lockFile(card);
    if (!fs.existsSync(f)) { console.error(`✗ ${card} ka lock nahi hai — pehle claim chalao.`); process.exit(1); }
    const me = JSON.parse(fs.readFileSync(f, "utf8"));
    const files = changedFiles();
    const conflicts = findConflicts(card, files, readLocks());
    if (conflicts.length) report(conflicts);
    enforceScope(card, "worktree", { lockDir: LOCK_DIR, allowOutside, cardPath: cardFlags.cardPath });
    me.files = [...new Set([...(me.files ?? []), ...files])];
    fs.writeFileSync(f, JSON.stringify(me, null, 2));
    console.log(`✓ ${files.length} badli files — kisi aur worker se takraav nahi.`);
    return;
  }
  if (cmd === "push") {
    const ciFlags = parseCiFlags(rest);
    enforceCard(card, "push", cardFlags);
    return pushWithTurn(card, { ...ciFlags, fullTsc: parseTscFlags(rest).full, allowOutside, cardPath: cardFlags.cardPath });
  }
  if (cmd === "ci") {
    /* R-1936: wait for this card's CI + SQL tests runs; exit 0 green, 7 red, 8 timeout. */
    const f = parseCiFlags(rest);
    const git = (gargs) => execFileSync("git", gargs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const isAncestor = (a, b) => { try { execFileSync("git", ["merge-base", "--is-ancestor", a, b], { stdio: "ignore" }); return true; } catch { return false; } };
    try { git(["fetch", "-q", "anutech"]); } catch {}
    return runCi(card, { gh: realGh, git, isAncestor, sha: f.sha, timeoutMin: f.timeoutMin, readNote: readPushedNote, print: (l) => console.log(l) })
      .then((r) => {
        for (const l of r.lines) (r.code ? console.error : console.log)(l);
        /* R-1973: green → lock removed (files free); red → ci-red (files kept, slot back with claim --fixes-red). */
        try {
          const u = updateLock(card, (l) => lockAfterCi(l, r.code, { at: new Date().toISOString() }));
          if (u.found && u.lock === null) console.log(`  ${card} ka lock hata (CI green) — files ab doosre cards ke liye khaali.`);
          else if (u.found && r.code === CI_EXIT.red) console.error(`  ${card} ci-red: files ka claim abhi bhi tumhara. Theek karne se pehle slot wapas lo: claim ${card} --fixes-red --card <card.json>, phir push ${card} … --fixes-red.`);
        } catch {}
        if (r.check) console.log(JSON.stringify(r.check));
        process.exit(r.code);
      });
  }
  if (cmd === "sql-related") {
    const r = runRelatedSql(relatedSqlDeps());
    (r.ok ? console.log : console.error)(r.message);
    if (!r.ok) process.exit(5);
    return;
  }
  if (cmd === "tsc") return tscWithTurn(card, parseTscFlags(rest)).then((ok) => { if (ok) console.log("✓ tsc green"); else process.exit(1); });
  if (cmd === "prep") return prep(card, rest);
  if (cmd === "release") {
    fs.rmSync(lockFile(card), { force: true });
    console.log(`✓ ${card} ka lock hata.`);
    return;
  }
  if (cmd === "wip" || cmd === "resume") {
    /* R-1898: real git, same interface the tests fake. */
    const git = (gargs, opts = {}) => execFileSync("git", gargs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...(opts.env ? { env: opts.env } : {}) });
    const r = cmd === "wip"
      ? runWip(card, { git, branch: rest[0] })
      : runResume(card, rest[0], { git, exists: (p) => fs.existsSync(p) });
    if (!r.ok) { console.error(r.message); process.exit(1); }
    console.log(r.message);
    return;
  }
  console.error("claim | check | push | ci | sql-related | wip | resume | tsc | prep | release | list | guard-push   (claim/push need --card <card.json>; tsc/push take --full-tsc)");
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv.slice(2));
