/**
 * R-2385 (2 Nov 2026) — `worker-lock cleanup <CARD>`: remove a worker's worktree WITHOUT ever deleting
 * through its node_modules junction.
 *
 * 2 Nov ~13:34 UTC a worker cleanup removed files inside the SHARED
 * C:/Users/mso50/reselleros-deploy/production/node_modules through its worktree's junction (@auth/core lost
 * its package.json, @anthropic-ai/sdk files were gone) → localhost Build Error until the coordinator ran
 * `npm ci`. A recursive delete (rm -rf, Remove-Item -Recurse, del /s, or a `git worktree remove` that still
 * finds the junction) walks INTO the link and deletes the shared files. So the order is fixed:
 *
 *   1. production/node_modules is a link → remove ONLY the link (Windows: `cmd /c rmdir <path>` — no /s;
 *      elsewhere unlink) and check the path is gone and the link's target still exists.
 *      It is a real folder with files → REFUSE (exit 11): never delete it here, tell the person what to do.
 *   2. delete the copied production/.env.local (and .env.test when a checker copied it) — single files only.
 *   3. `git worktree remove <path>` (never --force), run from the main clone, never from inside the worktree.
 *   4. `git branch -D <branch>` only when the branch is already in anutech/manager-pardeep or
 *      anutech/wip/<card> exists — otherwise the branch is kept and that is said. R-2561 (7 Nov 2026):
 *      <branch> is the branch checked out in THIS worktree (read from `git worktree list --porcelain`
 *      before the worktree goes), never a name built from the card id: R-1495's worker used w-r-1495b and
 *      cleanup would have deleted an older w-r-1495 from a past worker. Detached / not found → no branch
 *      is deleted.
 *
 * Every effect is injected (`deps`) so tests use fakes; `--dry-run` prints the steps and changes nothing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const CLEANUP_EXIT = { ok: 0, usage: 1, refused: 11, failed: 12 };
export const ENV_FILES = [".env.local", ".env.test"];

/** `cleanup <CARD> [--worktree <path>] [--dry-run]` → { worktree, dryRun, rest }. */
export function parseCleanupFlags(args = []) {
  const rest = [];
  let worktree = null, dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--worktree") worktree = args[++i] ?? null;
    else if (a.startsWith("--worktree=")) worktree = a.slice("--worktree=".length);
    else rest.push(a);
  }
  return { worktree, dryRun, rest };
}

export const defaultWorktree = (card, home = os.homedir()) => path.join(home, `reselleros-w-${String(card).toLowerCase()}`);
export const workerBranch = (card) => `w-${String(card).toLowerCase()}`;
/** R-2561: w-r-1495, w-r-1495b, w-r-1495-fix are R-1495's worker branches; w-r-14950 and manager-pardeep are not. */
export const isCardWorkerBranch = (branch, card) => {
  const b = String(branch ?? "").toLowerCase(), base = workerBranch(card);
  return b.startsWith(base) && !/^[0-9]/.test(b.slice(base.length));
};

/**
 * R-2561: the branch checked out in `worktree`, from `git worktree list --porcelain` output — or null
 * (detached HEAD, bare, or the worktree is not listed). Paths compare resolved, case-insensitive on Windows.
 */
export function worktreeBranch(porcelain, worktree, platform = process.platform) {
  const norm = (x) => { const r = path.resolve(x).replace(/[\\/]+$/, ""); return platform === "win32" ? r.toLowerCase() : r; };
  const want = norm(worktree);
  for (const block of String(porcelain ?? "").replace(/\r\n/g, "\n").split(/\n\s*\n/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const wt = lines.find((l) => l.startsWith("worktree "));
    if (!wt || norm(wt.slice("worktree ".length)) !== want) continue;
    const br = lines.find((l) => l.startsWith("branch "));
    return br ? br.slice("branch ".length).replace(/^refs\/heads\//, "") : null;
  }
  return null;
}

/**
 * What production/node_modules is: "none" | "link" (junction/symlink; `target`) | "empty-dir" | "dir" (real
 * folder with files — never ours to delete). `fsx` = { lstat, readlink, readdir } (throwing like node:fs).
 */
export function inspectNodeModules(nm, fsx) {
  let st;
  try { st = fsx.lstat(nm); } catch { return { kind: "none" }; }
  if (st.isSymbolicLink()) {
    let target = null;
    try { target = fsx.readlink(nm); } catch {}
    return { kind: "link", target };
  }
  if (st.isDirectory()) {
    let entries = [];
    try { entries = fsx.readdir(nm); } catch {}
    return entries.length ? { kind: "dir", count: entries.length } : { kind: "empty-dir" };
  }
  return { kind: "file" };
}

/** Is `p` the same as `dir` or inside it (case-insensitive on Windows)? */
export function isInside(p, dir, platform = process.platform) {
  const norm = (x) => { const r = path.resolve(x).replace(/[\\/]+$/, ""); return platform === "win32" ? r.toLowerCase() : r; };
  const a = norm(p), b = norm(dir);
  return a === b || a.startsWith(b + path.sep) || a.startsWith(b + "/");
}

/**
 * Run the cleanup. deps: { platform, cwd, chdir, exists, lstat, readlink, readdir, rmFile, rmdirLink(path),
 * git(args) → stdout (throws on non-zero), print, printErr }. Returns { code, steps } — steps are the lines
 * printed (also in dry-run).
 */
export function runCleanup(card, opts, deps) {
  const { dryRun = false } = opts;
  const worktree = path.resolve(opts.worktree ?? defaultWorktree(card, deps.home));
  const nm = path.join(worktree, "production", "node_modules");
  const rootNm = path.join(worktree, "node_modules");
  const steps = [];
  const say = (l) => { steps.push(l); deps.print(l); };
  const stop = (code, l) => { steps.push(l); deps.printErr(l); return { code, steps }; };
  const tag = dryRun ? "[dry-run] " : "";

  if (!deps.exists(worktree)) return stop(CLEANUP_EXIT.usage, `✗ ${worktree} nahi mila — --worktree <path> do.`);

  /* The main clone (common git dir's parent): git runs from there, never from inside the worktree. */
  let mainRepo;
  try {
    const common = deps.git(["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
    mainRepo = path.dirname(path.resolve(common));
  } catch (e) {
    return stop(CLEANUP_EXIT.refused, `✗ ${worktree} git worktree nahi lagta (${String(e?.message ?? e).split("\n")[0]}) — kuch nahi hataya.`);
  }
  if (isInside(mainRepo, worktree, deps.platform)) return stop(CLEANUP_EXIT.refused, `✗ ${worktree} main clone hai, worker worktree nahi — kuch nahi hataya.`);

  /* R-2561: the branch to delete later is the one THIS worktree has checked out — read now, while git still lists it. */
  let branch = null;
  try { branch = worktreeBranch(deps.git(["-C", mainRepo, "worktree", "list", "--porcelain"]), worktree, deps.platform); } catch {}

  /* Step 1: every node_modules link goes first, one by one; a real folder with files → refuse. */
  for (const p of [nm, rootNm]) {
    const s = inspectNodeModules(p, deps);
    if (s.kind === "none") { if (p === nm) say(`1. ${p}: koi node_modules nahi — link hatane ki zaroorat nahi.`); continue; }
    if (s.kind === "dir" || s.kind === "file") {
      return stop(CLEANUP_EXIT.refused, [
        `✗ RUKA: ${p} asli ${s.kind === "dir" ? `folder hai (${s.count} cheezein)` : "file hai"}, junction nahi — cleanup ise kabhi nahi mitata.`,
        `  Kya karo: dekho ye kahan se aaya (npm ci worktree me chala?). Agar ye SIRF is worktree ki copy hai to`,
        `  Pardeep/coordinator se poochh kar khud hatao; agar ye kisi aur jagah ka link lagta hai to haath mat lagao.`,
        `  Phir: worker-lock cleanup ${card} --worktree ${worktree}`,
      ].join("\n"));
    }
    if (s.kind === "empty-dir") {
      say(`1. ${tag}${p}: khaali folder — sirf ye khaali folder hatega (non-recursive).`);
      if (!dryRun) { try { deps.rmdirEmpty(p); } catch (e) { return stop(CLEANUP_EXIT.failed, `✗ ${p} nahi hata: ${e?.message ?? e}`); } }
      continue;
    }
    /* link */
    const how = deps.platform === "win32" ? `cmd /c rmdir "${p}"` : `unlink ${p}`;
    say(`1. ${tag}${p} → ${s.target ?? "?"}: SIRF link hatega (${how}) — target ki files ko haath nahi.`);
    if (dryRun) continue;
    try { deps.rmdirLink(p); } catch (e) { return stop(CLEANUP_EXIT.failed, `✗ link nahi hata (${how}): ${String(e?.message ?? e).split("\n")[0]} — worktree nahi hataya.`); }
    if (inspectNodeModules(p, deps).kind !== "none") return stop(CLEANUP_EXIT.refused, `✗ RUKA: ${p} abhi bhi hai — junction ke saath worktree remove nahi karenge (wahi 2 Nov wali galti). Kuch aur nahi hataya.`);
    say(`   ✓ ${p} ab nahi hai.`);
    if (s.target) {
      const tgt = path.resolve(path.dirname(p), s.target);
      if (deps.exists(tgt)) say(`   ✓ target ${tgt} abhi bhi hai.`);
      else say(`   ⚠ target ${tgt} nahi dikha — coordinator ko batao (cleanup ne use nahi chhua).`);
    }
  }

  /* Step 2: copied env files — single files, never folders. */
  for (const f of ENV_FILES) {
    const p = path.join(worktree, "production", f);
    if (!deps.exists(p)) continue;
    say(`2. ${tag}${p} hatega (copy ki hui env file).`);
    if (!dryRun) { try { deps.rmFile(p); } catch (e) { return stop(CLEANUP_EXIT.failed, `✗ ${p} nahi hata: ${e?.message ?? e}`); } }
  }

  /* Step 3: git worktree remove (no --force), from the main clone. Leave the worktree first if we are in it. */
  if (isInside(deps.cwd(), worktree, deps.platform)) {
    say(`3. ${tag}abhi ka folder worktree ke andar hai → pehle ${mainRepo} me jaate hain.`);
    if (!dryRun) deps.chdir(mainRepo);
  }
  say(`3. ${tag}git -C ${mainRepo} worktree remove ${worktree}   (--force nahi)`);
  if (!dryRun) {
    try { deps.git(["-C", mainRepo, "worktree", "remove", worktree]); }
    catch (e) {
      return stop(CLEANUP_EXIT.failed, [
        `✗ git worktree remove nahi hua: ${String(e?.stderr ?? e?.message ?? e).trim().split("\n")[0]}`,
        `  Badli/nayi files hongi — commit karo (WIP) ya dekho; --force mat lagao. node_modules link pehle hi hat chuka hai.`,
      ].join("\n"));
    }
    say(`   ✓ worktree hata.`);
  }

  /* Step 4: the branch — only when its work is safe elsewhere. */
  const done = () => { if (dryRun) say(`[dry-run] kuch nahi badla.`); return { code: CLEANUP_EXIT.ok, steps }; };
  const g = (args) => { try { return { ok: true, out: deps.git(["-C", mainRepo, ...args]) }; } catch { return { ok: false }; } };
  if (!branch) { say(`4. is worktree par koi branch nahi mili (detached, ya git worktree list me ye path nahi) — koi branch nahi hategi (naam se andaza nahi lagate).`); return done(); }
  /* Only this card's worker branch (w-<card>, w-<card>b, …) — never manager-pardeep / preview-* / another card's
     w-r-NNNN when --worktree points at the wrong folder. */
  if (!isCardWorkerBranch(branch, card)) { say(`4. branch ${branch} RAKHA: ye ${workerBranch(card)}… worker branch nahi — cleanup sirf is card ki worker branch mitata hai.`); return done(); }
  if (!g(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok) { say(`4. branch ${branch} nahi hai — kuch nahi karna.`); return done(); }
  g(["fetch", "-q", "anutech"]);
  const merged = g(["merge-base", "--is-ancestor", branch, "anutech/manager-pardeep"]).ok;
  /* wip counts only when it holds the branch tip (commits after the last wip push would be lost). */
  const wip = g(["merge-base", "--is-ancestor", branch, `refs/remotes/anutech/wip/${String(card).toLowerCase()}`]).ok;
  if (!merged && !wip) {
    say(`4. branch ${branch} RAKHA: na anutech/manager-pardeep me hai, na anutech/wip/${String(card).toLowerCase()} — pehle push/wip karo, phir git branch -D ${branch}.`);
    return done();
  }
  say(`4. ${tag}git branch -D ${branch}   (${merged ? "manager-pardeep me merged" : `anutech/wip/${String(card).toLowerCase()} pe hai`})`);
  if (!dryRun) {
    if (!g(["branch", "-D", branch]).ok) return stop(CLEANUP_EXIT.failed, `✗ git branch -D ${branch} nahi hua.`);
    say(`   ✓ branch hata.`);
  }
  return done();
}

/** Real effects. rmdirLink on Windows: `cmd /c rmdir` WITHOUT /s removes the junction only. */
export function realCleanupDeps() {
  const platform = process.platform;
  return {
    platform,
    home: os.homedir(),
    cwd: () => process.cwd(),
    chdir: (d) => process.chdir(d),
    exists: (p) => { try { fs.lstatSync(p); return true; } catch { return false; } },
    lstat: (p) => fs.lstatSync(p),
    readlink: (p) => fs.readlinkSync(p),
    readdir: (p) => fs.readdirSync(p),
    rmFile: (p) => fs.unlinkSync(p),
    rmdirEmpty: (p) => fs.rmdirSync(p),
    rmdirLink: (p) => {
      if (platform === "win32") execFileSync("cmd", ["/c", "rmdir", path.resolve(p)], { stdio: ["ignore", "pipe", "pipe"] });
      else fs.unlinkSync(p);
    },
    git: (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    print: (l) => console.log(l),
    printErr: (l) => console.error(l),
  };
}
