/**
 * Staging train — R-386 (7 Oct 2026). The MANAGER runs this every 2–3 hours; it never runs by
 * itself and it never touches live (`deploy` branch / live DB).
 *
 * Why: staging was merged once a day at 17:00 IST. On 7 Oct 40+ commits piled up, and every new
 * push restarted CI, so the "one big merge" kept slipping. A small, frequent batch is faster and
 * a broken commit is easier to find.
 *
 *   node scripts/ops/staging-train.mjs              dry run: pick the green commit, check
 *                                                   migrations, test-merge in a temp worktree
 *   node scripts/ops/staging-train.mjs --db-done    staging DB step already done for the new migrations
 *   node scripts/ops/staging-train.mjs --push       also run `git push anutech HEAD:staging`
 *   node scripts/ops/staging-train.mjs --sha <sha> [--dry-run | --db-done --push]
 *                                                   R-2106: pin the train to THAT commit (must be on
 *                                                   manager-pardeep and CI-green, else refused). The dry run,
 *                                                   the DB step (that commit's deploy-db script, run from a temp
 *                                                   worktree of it) and the merge all use the same commit.
 *   --dry-run                                       explicit: never push (refused together with --push)
 *
 * R-2106 (31 Oct 2026): twice on 29–30 Oct the newest-green rule picked a NEWER commit between the dry
 * run and the DB step (its migrations not on the staging DB yet, its cards not localhost-checked); on
 * 30 Oct the coordinator had to merge dd02c3e1 into staging by hand. Use --sha for every real train.
 *
 * Steps: fetch anutech → newest commit on anutech/manager-pardeep whose GitHub "CI" run finished
 * green (same rule as staging-gate.mjs) → new migration files vs anutech/staging (stop unless
 * --db-done) → in a temporary worktree: staging + `git merge --no-ff <sha>` (conflict = abort +
 * stop) → push only with --push. NEVER a force push: staging carries R-161 commits that
 * manager-pardeep lacks, so a force push would break staging.
 *
 * R-1721 (21 Oct 2026): after --push it no longer trusts --db-done. It waits until staging's
 * /api/version shows the merge commit (7 characters — 21 Oct an 8-char compare never matched),
 * then reads /api/health/migrations: green "✓ Sab migrations DB par", or red "DB step chhoot
 * gaya: <keys>" and exit 5. No MIGRATIONS_HEALTH_TOKEN here → a yellow line, never silence.
 * (scripts/ops/migrations-health-check.mjs)
 *
 * R-1722 (24 Oct 2026): after a green --push, run the smoke check against staging —
 * `SMOKE_EMAIL=… SMOKE_PASSWORD=… npm run smoke -- <staging URL>` (scripts/ops/smoke-check.mjs,
 * docs/ARCHITECTURE.md §8): 17 real pages, logged in, exit 1 on any red page.
 *
 * Exit 0 = ok (dry run done / pushed / nothing new). 1 = error or refused. 2 = merge conflict.
 * 3 = DB step needed. 4 = pushed, but the migration check could not run. 5 = pushed, and the
 * staging DB is missing migrations. Run from production/.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, existsSync, rmSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO, REMOTE, BRANCH, WORKFLOW, ciDecision } from "./staging-gate.mjs";
import { runCheck, colour, STAGING_URL } from "./migrations-health-check.mjs";

export const STAGING = "staging";
export const MIGRATIONS_DIR = "production/supabase/migrations";
export const PUSH_ARGS = ["push", REMOTE, "HEAD:staging"];

/** argv (without node + script) → { dbDone, push, help, sha, dryRun }. */
export function parseArgs(argv) {
  const out = { dbDone: false, push: false, help: false, sha: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db-done") out.dbDone = true;
    else if (a === "--push") out.push = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--sha" || a.startsWith("--sha=")) {
      const v = a === "--sha" ? argv[++i] : a.slice("--sha=".length);
      if (!v || !/^[0-9a-f]{7,40}$/i.test(v)) throw new Error("--sha <commit> chahiye (7–40 hex)");
      out.sha = v.toLowerCase();
    } else throw new Error(`Unknown argument ${a} (sirf --sha <commit> / --dry-run / --db-done / --push / --help)`);
  }
  if (out.dryRun && out.push) throw new Error("--dry-run aur --push saath nahi — dry-run kabhi push nahi karta");
  return out;
}

/**
 * R-2106: the commit a pinned train uses. git(args) → stdout (throws on a non-zero exit);
 * runsFor(fullSha) → that commit's own CI runs, newest first ({status, conclusion}).
 * → { ok, pick, alreadyInStaging, message }. Refused unless the commit exists, is on manager-pardeep
 * and its own CI run is completed+success (staging-gate's ciDecision).
 */
export function resolvePinned(sha, { git, runsFor }) {
  let full;
  try { full = git(["rev-parse", "--verify", `${sha}^{commit}`]).trim(); }
  catch { return { ok: false, pick: null, message: `✗ --sha ${sha}: commit nahi mila (git fetch ${REMOTE}?).` }; }
  const isAncestor = (ref) => { try { git(["merge-base", "--is-ancestor", full, ref]); return true; } catch { return false; } };
  if (!isAncestor(`${REMOTE}/${BRANCH}`)) return { ok: false, pick: null, message: `✗ ${full.slice(0, 8)} ${REMOTE}/${BRANCH} par nahi hai — sirf manager-pardeep ka commit staging jaata hai.` };
  if (isAncestor(`${REMOTE}/${STAGING}`)) return { ok: true, pick: full, alreadyInStaging: true, message: `✓ ${full.slice(0, 8)} pehle se staging me hai.` };
  const ci = ciDecision(runsFor(full), full);
  if (!ci.ok) return { ok: false, pick: null, message: ci.message };
  return { ok: true, pick: full, alreadyInStaging: false, message: `📌 Pinned: ${full.slice(0, 8)} (CI hara)` };
}

/**
 * R-2106: the DB step for a pinned commit — that commit's newest staging deploy-db script, run from a
 * temporary worktree of that commit (the script reads ../../migrations next to itself), then removed.
 * `names` = `git ls-tree --name-only <sha> production/supabase/cloudsql/staging/` basenames.
 */
export function pinnedDbStepLines(sha, names, tmpDir) {
  const name = newestDeployDb(names.map((n) => String(n).split("/").pop()));
  if (!name) return [`✗ ${sha.slice(0, 8)} me ${STAGING_SCRIPTS_DIR}/deploy-db-<date>.sh nahi mila.`];
  const dir = String(tmpDir).replace(/\\/g, "/");
  return [
    `DB step — sirf commit ${sha.slice(0, 8)} ki ${name} (Git Bash, repo ke andar se):`,
    `  git worktree add --detach "${dir}" ${sha}`,
    `  bash "${dir}/${STAGING_SCRIPTS_DIR}/${name}"`,
    `  git worktree remove "${dir}"`,
    `Phir: node scripts/ops/staging-train.mjs --sha ${sha.slice(0, 12)} --db-done --push`,
  ];
}

const CARD_RE = /\bR-\d{2,4}[a-z]?\b/g;

/** Commit subjects → unique card ids ("R-161", "R-381b"), sorted by number. */
export function extractCardIds(subjects) {
  const set = new Set();
  for (const s of subjects) for (const m of String(s).matchAll(CARD_RE)) set.add(m[0]);
  const num = (id) => Number(id.match(/\d+/)[0]);
  return [...set].sort((a, b) => num(a) - num(b) || a.localeCompare(b));
}

/** `git diff --name-only --diff-filter=A` output → added migration .sql files, sorted. */
export function parseAddedMigrations(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/\\/g, "/"))
    .filter((l) => l.startsWith(`${MIGRATIONS_DIR}/`) && l.endsWith(".sql"))
    .sort();
}

/**
 * R-540 (10 Oct 2026): staging (R-161) keeps applied migrations as prisma/migrations/<name>/migration.sql,
 * so a supabase/migrations/<name>.sql that arrives from manager-pardeep may already be there. Those are
 * not new — they made the dry run ask for a DB step it did not need.
 * `lsTreeText` = `git ls-tree --name-only <staging> production/prisma/migrations/` output.
 */
export function dropAlreadyInPrisma(migrations, lsTreeText) {
  const have = new Set(String(lsTreeText ?? "").split(/\r?\n/).map((l) => l.trim().replace(/\\/g, "/").split("/").pop()).filter(Boolean));
  return migrations.filter((m) => !have.has(m.split("/").pop().replace(/\.sql$/, "")));
}

/**
 * `gh run list --json headSha,status,conclusion` (newest first) → Map sha → runs (newest first).
 */
export function groupRunsBySha(text) {
  const s = String(text ?? "").trim();
  const map = new Map();
  if (!s) return map;
  const data = JSON.parse(s);
  if (!Array.isArray(data)) throw new Error("gh output is not a JSON array");
  for (const r of data) {
    const sha = String(r.headSha ?? "");
    if (!sha) continue;
    if (!map.has(sha)) map.set(sha, []);
    map.get(sha).push({ status: String(r.status ?? ""), conclusion: String(r.conclusion ?? "") });
  }
  return map;
}

/**
 * Commits (newest first) + runs per sha → { pick, newer }.
 * pick = newest commit whose newest CI run is completed+success (staging-gate's ciDecision);
 * newer = commits above it, counted as running / red / noRun (no run of their own —
 * usually pushed together with a later commit, so CI only ran on the tip).
 */
export function pickGreen(commits, runsBySha) {
  const newer = { running: 0, red: 0, noRun: 0 };
  for (const sha of commits) {
    const runs = runsBySha.get(sha) ?? [];
    if (ciDecision(runs, sha).ok) return { pick: sha, newer };
    if (!runs.length) newer.noRun++;
    else if (runs[0].status !== "completed") newer.running++;
    else newer.red++;
  }
  return { pick: null, newer };
}

/**
 * The decision table. → { action, exitCode, message }
 *   staging already has everything   → nothing (0)
 *   no green commit                  → refuse (1)
 *   migrations and no --db-done      → db-step (3)
 *   otherwise                        → merge; push only with --push, else dry run
 */
export function decide({ pick, alreadyInStaging, migrations, dbDone, push }) {
  if (alreadyInStaging) {
    return { action: "nothing", exitCode: 0, message: "✓ manager-pardeep ka sab kuch pehle se staging me hai — kuch naya nahi." };
  }
  if (!pick) {
    return { action: "refuse", exitCode: 1, message: "✗ manager-pardeep par koi CI-hara commit nahi mila — staging train nahi chalegi." };
  }
  if (migrations.length && !dbDone) {
    return {
      action: "db-step",
      exitCode: 3,
      message: `DB STEP NEEDED — ${migrations.length} naye migration staging DB par pehle lagao, phir --db-done ke saath dobara chalao.`,
    };
  }
  return push
    ? { action: "merge-push", exitCode: 0, message: "merge + push (--push)" }
    : { action: "merge-dry", exitCode: 0, message: "dry run — push nahi (--push nahi diya)" };
}

/** Date → "07 Oct 14:30 IST" and "2026-10-07" (IST). */
export function istStamp(date = new Date()) {
  const ist = new Date(date.getTime() + 330 * 60 * 1000);
  const iso = ist.toISOString();
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][ist.getUTCMonth()];
  return { label: `${iso.slice(8, 10)} ${mon} ${iso.slice(11, 16)} IST`, day: iso.slice(0, 10) };
}

export function mergeMessage(label, cards) {
  return `Staging train ${label}: ${cards.length ? cards.join(", ") : "no card ids"}`;
}

export const STAGING_SCRIPTS_DIR = "production/supabase/cloudsql/staging";

/**
 * R-1590 (18 Oct 2026): the staging DB script the manager actually runs. It used to be named
 * after TODAY's IST date (deploy-db-2026-10-18.sh — never existed: gen-deploy-db writes one file
 * per deploy date and keeps adding to it) under a path hard-coded to the main checkout. Now: the
 * newest existing deploy-db-YYYY-MM-DD.sh, or null when there is none.
 */
export function newestDeployDb(names) {
  const dated = names.filter((n) => /^deploy-db-\d{4}-\d{2}-\d{2}\.sh$/.test(n)).sort();
  return dated.length ? dated[dated.length - 1] : null;
}

/** The PowerShell line that runs `scriptAbs` with Git Bash — path relative to `cwd`, the checkout the train runs in. */
export function dbCommand(scriptAbs, cwd = process.cwd()) {
  const rel = path.relative(cwd, scriptAbs).split(path.sep).join("/");
  return `& "C:\\Program Files\\Git\\bin\\bash.exe" "${rel}"`;
}

/** DB-step lines for the newest staging deploy-db script under `root` (repo top), or a clear error. */
export function dbStepLines(root, cwd = process.cwd(), list = (d) => (existsSync(d) ? readdirSync(d) : [])) {
  const dir = path.join(root, ...STAGING_SCRIPTS_DIR.split("/"));
  const name = newestDeployDb(list(dir));
  if (!name) {
    return [
      `✗ ${STAGING_SCRIPTS_DIR} me koi deploy-db-<date>.sh nahi mila.`,
      "  Pehle banao: node scripts/ops/gen-deploy-db.mjs --date <YYYY-MM-DD>",
    ];
  }
  const date = name.slice("deploy-db-".length, -".sh".length);
  return [
    "PowerShell:",
    `  ${dbCommand(path.join(dir, name), cwd)}`,
    `(Naye migrations is file me hain? Jaancho: node scripts/ops/gen-deploy-db.mjs --date ${date} --check)`,
  ];
}

/** Final Hinglish summary lines. */
export function summaryLines({ pick, cards, migrations, decision, merged, pushed }) {
  const lines = ["", "── Staging train ──"];
  if (pick) lines.push(`Commit: ${pick.slice(0, 8)}`);
  lines.push(`Cards: ${cards.length ? cards.join(", ") : "—"}`);
  lines.push(`Migrations: ${migrations.length ? migrations.map((m) => path.posix.basename(m)).join(", ") : "koi nahi"}`);
  let next;
  if (decision.action === "refuse") next = "CI hara hone do (ya laal theek karo), phir dobara chalao.";
  else if (decision.action === "nothing") next = "Kuch nahi — 2-3 ghante baad dobara.";
  else if (decision.action === "db-step") next = "Upar wala DB command chalao (Pardeep ki haan), phir `--db-done` ke saath train dobara.";
  else if (merged === null) next = "Error — upar ka message dekho, phir dobara.";
  else if (merged === false) next = "Merge CONFLICT — upar ki files theek karo (manager-pardeep par), phir dobara.";
  else if (pushed) next = "Push ho gaya — upar ki migration line padho (hara = DB theek; laal = DB step chalao; peela = khud jaancho).";
  else next = "Merge saaf hai. Asli push ke liye `--push` ke saath dobara chalao.";
  lines.push(`Agla kadam: ${next}`);
  return lines;
}

/* ───────────── side effects below — not covered by unit tests (no network in tests) ───────────── */

const git = (args, opts = {}) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

function repoRoot() {
  return git(["rev-parse", "--show-toplevel"]).trim();
}

function commitsAhead(limit = 500) {
  /* Commits on manager-pardeep not yet in staging, newest first. */
  const out = git(["rev-list", `--max-count=${limit}`, `${REMOTE}/${BRANCH}`, `^${REMOTE}/${STAGING}`]);
  return out.split(/\r?\n/).filter(Boolean);
}

function fetchRunsBySha() {
  const out = execFileSync(
    "gh",
    ["run", "list", "--repo", REPO, "--branch", BRANCH, "--workflow", WORKFLOW, "--limit", "100", "--json", "headSha,status,conclusion"],
    { encoding: "utf8" },
  );
  return groupRunsBySha(out);
}

/** R-2106: the pinned commit's own "CI" runs (newest first) — not limited to the last 100 runs of the branch. */
function fetchRunsForCommit(sha) {
  const out = execFileSync(
    "gh",
    ["run", "list", "--repo", REPO, "--commit", sha, "--workflow", WORKFLOW, "--limit", "20", "--json", "headSha,status,conclusion"],
    { encoding: "utf8" },
  );
  return groupRunsBySha(out).get(sha) ?? [];
}

function removeWorktree(root, dir) {
  try {
    git(["worktree", "remove", "--force", dir], { cwd: root });
  } catch {
    /* fall through to manual cleanup */
  }
  if (existsSync(dir)) {
    /* Only reached if git left the folder. It never holds a node_modules junction (we never create one). */
    if (existsSync(path.join(dir, "production", "node_modules"))) {
      console.error(`! ${dir} me node_modules mila — haath se hatao (junction .Delete() pehle). Folder chhoda.`);
      return;
    }
    rmSync(dir, { recursive: true, force: true });
    /* R-2106: never `git worktree prune` (it can drop other sessions' worktrees whose folder is briefly
       unreachable). The stale entry for this temp folder is harmless; `git worktree list` shows it. */
    console.error(`! ${dir} haath se hataya; git ki worktree entry rehne di (prune kabhi nahi).`);
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
  if (args.help) {
    console.log("node scripts/ops/staging-train.mjs [--sha <commit>] [--dry-run | --db-done --push]   (bina --push = dry run)");
    return;
  }

  const root = repoRoot();
  let pick, newer, ahead, alreadyInStaging;
  try {
    git(["fetch", "-q", REMOTE], { cwd: root });
    if (args.sha) {
      /* R-2106: pinned — exactly this commit, or nothing. */
      const p = resolvePinned(args.sha, { git: (a) => git(a, { cwd: root }), runsFor: fetchRunsForCommit });
      console.log(p.message);
      if (!p.ok) process.exit(1);
      pick = p.pick;
      alreadyInStaging = p.alreadyInStaging;
      ahead = alreadyInStaging ? [] : [pick];
      newer = { running: 0, red: 0, noRun: 0 };
    } else {
      ahead = commitsAhead();
      ({ pick, newer } = pickGreen(ahead, fetchRunsBySha()));
      alreadyInStaging = ahead.length === 0;
    }
  } catch (e) {
    console.error(`✗ git/gh error — train nahi chalegi.\n${e.message}`);
    process.exit(1);
  }

  const newerTotal = newer.running + newer.red + newer.noRun;
  if (args.sha) {
    const tip = git(["rev-parse", `${REMOTE}/${BRANCH}`], { cwd: root }).trim();
    if (pick && tip !== pick) console.log(`  (pinned: manager-pardeep ka tip ${tip.slice(0, 8)} hai — uske naye commit is train me NAHI jaayenge)`);
  } else if (pick) {
    console.log(`✓ CI-hara commit: ${pick.slice(0, 8)} (${git(["log", "-1", "--format=%s", pick], { cwd: root }).trim()})`);
    console.log(
      `  Isse naye ${newerTotal} commit abhi nahi jaayenge: ${newer.running} CI chal raha, ${newer.red} CI laal, ${newer.noRun} bina apne CI run ke.`,
    );
  } else if (alreadyInStaging) {
    pick = git(["rev-parse", `${REMOTE}/${BRANCH}`], { cwd: root }).trim();
  } else {
    console.log(`  ${ahead.length} commit staging se aage — ${newer.running} CI chal raha, ${newer.red} laal, ${newer.noRun} bina run.`);
  }

  let cards = [];
  let migrations = [];
  if (pick && !alreadyInStaging) {
    const subjects = git(["log", "--format=%s", `${REMOTE}/${STAGING}..${pick}`], { cwd: root }).split(/\r?\n/).filter(Boolean);
    cards = extractCardIds(subjects);
    migrations = dropAlreadyInPrisma(
      parseAddedMigrations(
        git(["diff", "--name-only", "--diff-filter=A", `${REMOTE}/${STAGING}`, pick, "--", MIGRATIONS_DIR], { cwd: root }),
      ),
      git(["ls-tree", "--name-only", `${REMOTE}/${STAGING}`, "production/prisma/migrations/"], { cwd: root }),
    );
    console.log(`  ${subjects.length} commit staging me jaayenge.`);
  }

  const decision = decide({ pick, alreadyInStaging, migrations, dbDone: args.dbDone, push: args.push });
  const { label } = istStamp();

  if (decision.action === "refuse" || decision.action === "nothing") {
    console.log(decision.message);
    for (const l of summaryLines({ pick, cards, migrations, decision })) console.log(l);
    process.exit(decision.exitCode);
  }

  if (migrations.length) {
    console.log(`\nNaye migrations (${migrations.length}):`);
    for (const m of migrations) console.log(`  ${m}`);
  }
  if (decision.action === "db-step") {
    const db = args.sha
      ? pinnedDbStepLines(pick, git(["ls-tree", "--name-only", pick, `${STAGING_SCRIPTS_DIR}/`], { cwd: root }).split(/\r?\n/).filter(Boolean), path.join(os.tmpdir(), `staging-db-${pick.slice(0, 8)}`))
      : dbStepLines(root);
    console.log(`\n${decision.message}\n${db.join("\n")}`);
    for (const l of summaryLines({ pick, cards, migrations, decision })) console.log(l);
    process.exit(decision.exitCode);
  }

  /* Merge in a throwaway worktree — never the main checkout. No node_modules junction is created. */
  const dir = mkdtempSync(path.join(os.tmpdir(), "staging-train-"));
  rmSync(dir, { recursive: true, force: true }); // git worktree add wants a missing/empty path
  let merged = null; // null = merge not tried (error), false = conflict
  let pushed = false;
  let pushedSha = null;
  let exitCode = 0;
  try {
    git(["worktree", "add", "-q", "--detach", dir, `${REMOTE}/${STAGING}`], { cwd: root });
    const msg = mergeMessage(label, cards);
    try {
      git(["merge", "--no-ff", "--no-edit", pick, "-m", msg], { cwd: dir });
      merged = true;
      console.log(`\n✓ Merge saaf: "${msg}"`);
    } catch {
      const files = git(["diff", "--name-only", "--diff-filter=U"], { cwd: dir }).split(/\r?\n/).filter(Boolean);
      try {
        git(["merge", "--abort"], { cwd: dir });
      } catch {
        /* worktree is thrown away anyway */
      }
      console.log(`\n✗ Merge CONFLICT (abort ho gaya) — ${files.length} file:`);
      for (const f of files) console.log(`  ${f}`);
      merged = false;
      exitCode = 2;
    }
    if (merged) {
      console.log(`Push command (worktree me, HEAD = merge commit): git ${PUSH_ARGS.join(" ")}`);
      if (args.push) {
        /* Plain push — a non-fast-forward (staging moved meanwhile) is REFUSED by git, never forced. */
        pushedSha = git(["rev-parse", "HEAD"], { cwd: dir }).trim();
        execFileSync("git", PUSH_ARGS, { cwd: dir, stdio: "inherit" });
        pushed = true;
        console.log("✓ staging par push ho gaya.");
      } else {
        console.log("(dry run — push nahi kiya; `--push` do)");
      }
    }
  } catch (e) {
    console.error(`✗ ${e.message}`);
    exitCode = 1;
  } finally {
    removeWorktree(root, dir);
  }
  if (pushed && pushedSha) {
    /* R-1721: does staging's DB really have every migration this build carries? */
    const v = await runCheck({ base: process.env.STAGING_URL || STAGING_URL, sha: pushedSha });
    console.log(`
${colour(v)}`);
    if (v.exitCode && !exitCode) exitCode = v.exitCode;
  }
  for (const l of summaryLines({ pick, cards, migrations, decision, merged, pushed })) console.log(l);
  process.exit(exitCode);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
