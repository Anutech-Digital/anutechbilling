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
 *
 * Steps: fetch anutech → newest commit on anutech/manager-pardeep whose GitHub "CI" run finished
 * green (same rule as staging-gate.mjs) → new migration files vs anutech/staging (stop unless
 * --db-done) → in a temporary worktree: staging + `git merge --no-ff <sha>` (conflict = abort +
 * stop) → push only with --push. NEVER a force push: staging carries R-161 commits that
 * manager-pardeep lacks, so a force push would break staging.
 *
 * Exit 0 = ok (dry run done / pushed / nothing new). 1 = error or refused. 2 = merge conflict.
 * 3 = DB step needed. Run from production/.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO, REMOTE, BRANCH, WORKFLOW, ciDecision } from "./staging-gate.mjs";

export const STAGING = "staging";
export const MIGRATIONS_DIR = "production/supabase/migrations";
export const PUSH_ARGS = ["push", REMOTE, "HEAD:staging"];

/** argv (without node + script) → { dbDone, push, help }. */
export function parseArgs(argv) {
  const out = { dbDone: false, push: false, help: false };
  for (const a of argv) {
    if (a === "--db-done") out.dbDone = true;
    else if (a === "--push") out.push = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`Unknown argument ${a} (sirf --db-done / --push / --help)`);
  }
  return out;
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

export function dbCommand(day) {
  return `& "C:\\Program Files\\Git\\bin\\bash.exe" "/c/Users/mso50/new-reselleros/production/supabase/cloudsql/staging/deploy-db-${day}.sh"`;
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
  else if (pushed) next = "Push ho gaya — Cloud Build staging bana raha hai; ~10 min baad staging URL par jaanch.";
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
    try {
      git(["worktree", "prune"], { cwd: root });
    } catch {
      /* ignore */
    }
  }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
  if (args.help) {
    console.log("node scripts/ops/staging-train.mjs [--db-done] [--push]   (bina --push = dry run)");
    return;
  }

  const root = repoRoot();
  let pick, newer, ahead;
  try {
    git(["fetch", "-q", REMOTE], { cwd: root });
    ahead = commitsAhead();
    ({ pick, newer } = pickGreen(ahead, fetchRunsBySha()));
  } catch (e) {
    console.error(`✗ git/gh error — train nahi chalegi.\n${e.message}`);
    process.exit(1);
  }

  const alreadyInStaging = ahead.length === 0;
  const newerTotal = newer.running + newer.red + newer.noRun;
  if (pick) {
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
    migrations = parseAddedMigrations(
      git(["diff", "--name-only", "--diff-filter=A", `${REMOTE}/${STAGING}`, pick, "--", MIGRATIONS_DIR], { cwd: root }),
    );
    console.log(`  ${subjects.length} commit staging me jaayenge.`);
  }

  const decision = decide({ pick, alreadyInStaging, migrations, dbDone: args.dbDone, push: args.push });
  const { label, day } = istStamp();

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
    console.log(`\n${decision.message}\nPowerShell:\n  ${dbCommand(day)}`);
    for (const l of summaryLines({ pick, cards, migrations, decision })) console.log(l);
    process.exit(decision.exitCode);
  }

  /* Merge in a throwaway worktree — never the main checkout. No node_modules junction is created. */
  const dir = mkdtempSync(path.join(os.tmpdir(), "staging-train-"));
  rmSync(dir, { recursive: true, force: true }); // git worktree add wants a missing/empty path
  let merged = null; // null = merge not tried (error), false = conflict
  let pushed = false;
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
  for (const l of summaryLines({ pick, cards, migrations, decision, merged, pushed })) console.log(l);
  process.exit(exitCode);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
