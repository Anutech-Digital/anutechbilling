/**
 * Live deploy gate — R-884 (12 Oct 2026). production/deploy.sh calls this BEFORE it ships anything.
 *
 * Why: deploy.sh used to run `gcloud run deploy --source .` from any laptop — no CI check, and the
 * Dockerfile defaults (no Auth.js / gateway build args) would build a Supabase-era live image.
 * Now a sha may only go live when ALL of these hold:
 *   1. the working tree is clean (what you test is what you ship)
 *   2. the exact sha is pushed to the `anutech` remote (some anutech/* branch contains it)
 *   3. GitHub "CI" and "SQL tests" finished green on that exact sha (newest run per workflow)
 * and deploy.sh then ships it ONLY through Cloud Build (push to the `deploy` branch → cloudbuild.yaml),
 * never `--source .`.
 *
 *   node scripts/ops/deploy-gate.mjs [<sha>] [--dry-run]
 *   node scripts/ops/deploy-gate.mjs [<sha>] --emergency     red/missing CI may be overridden, but only
 *                                                             after typing the confirmation phrase; logged.
 * Exit 0 = allowed (last stdout line: `SHA=<full sha>`). Exit 1 = refused (message says why).
 * The emergency override never skips checks 1–2: a dirty or unpushed sha cannot be built by Cloud Build.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export const REPO = "Anutech-Digital/anutechbilling";
export const REMOTE = "anutech";
export const REQUIRED_WORKFLOWS = ["CI", "SQL tests"];
export const OVERRIDE_LOG = path.join(os.homedir(), ".reselleros", "deploy-overrides.log");

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** argv (without node + script) → { sha, dryRun, emergency, help }. sha null = HEAD. */
export function parseArgs(argv) {
  const out = { sha: null, dryRun: false, emergency: false, help: false };
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--emergency") out.emergency = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("-")) throw new Error(`Unknown flag ${a} (sirf --dry-run / --emergency / --help)`);
    else if (SHA_RE.test(a)) out.sha = a;
    else throw new Error(`"${a}" commit SHA nahi hai — pass a commit SHA (7-40 hex chars)`);
  }
  return out;
}

/** The exact words Pardeep must type to override a red/missing CI on this sha. */
export function overridePhrase(sha) {
  return `DEPLOY ${String(sha).slice(0, 8)} WITHOUT GATE`;
}

/** `git status --porcelain` output → check. */
export function checkClean(porcelain) {
  const lines = String(porcelain ?? "").split(/\r?\n/).filter((l) => l.trim());
  return lines.length === 0
    ? { ok: true, message: "✓ Working tree clean." }
    : { ok: false, message: `✗ Working tree dirty (${lines.length} file(s)) — commit/stash first. ${lines.slice(0, 3).join(", ")}` };
}

/** `git branch -r --contains <sha>` output → check: must be on some anutech/* branch. */
export function checkPushed(remoteBranches, sha, remote = REMOTE) {
  const short = String(sha).slice(0, 8);
  const hit = String(remoteBranches ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^\*\s*/, ""))
    .find((l) => l.startsWith(`${remote}/`) && !l.includes("->"));
  return hit
    ? { ok: true, message: `✓ ${short} is pushed (${hit}).` }
    : { ok: false, message: `✗ ${short} is not pushed to ${remote} — push it and let CI run first.` };
}

/** `gh run list --json workflowName,status,conclusion` output → runs (newest first, as gh returns). */
export function parseRuns(text) {
  const s = String(text ?? "").trim();
  if (!s) return [];
  const data = JSON.parse(s);
  if (!Array.isArray(data)) throw new Error("gh output is not a JSON array");
  return data.map((r) => ({
    workflowName: String(r.workflowName ?? ""),
    status: String(r.status ?? ""),
    conclusion: String(r.conclusion ?? ""),
  }));
}

/** Runs → one check per required workflow. Only the NEWEST run of each counts (a red re-run beats an old green). */
export function checkWorkflows(runs, sha, required = REQUIRED_WORKFLOWS) {
  const short = String(sha).slice(0, 8);
  return required.map((wf) => {
    const r = runs.find((x) => x.workflowName === wf);
    if (!r) return { ok: false, ci: true, message: `✗ ${wf}: no run on ${short} — push and wait for it.` };
    if (r.status !== "completed")
      return { ok: false, ci: true, message: `✗ ${wf}: still ${r.status || "running"} on ${short} — wait.` };
    if (r.conclusion !== "success")
      return { ok: false, ci: true, message: `✗ ${wf}: red (${r.conclusion || "no conclusion"}) on ${short}.` };
    return { ok: true, ci: true, message: `✓ ${wf}: green on ${short}.` };
  });
}

/**
 * The whole decision. Pure: facts in, verdict out.
 * typed = what the person typed at the confirmation prompt (only asked for when emergency + CI red).
 */
export function decide({ sha, porcelain, remoteBranches, runs, emergency = false, typed = null }) {
  const checks = [checkClean(porcelain), checkPushed(remoteBranches, sha), ...checkWorkflows(runs, sha)];
  const hardFail = checks.some((c) => !c.ok && !c.ci);
  const ciFail = checks.some((c) => !c.ok && c.ci);
  const lines = checks.map((c) => c.message);
  if (hardFail) return { ok: false, overridden: false, needsPhrase: false, lines: [...lines, "MANA (REFUSED) — fix the ✗ above. Emergency cannot skip a dirty/unpushed sha."] };
  if (!ciFail) return { ok: true, overridden: false, needsPhrase: false, lines: [...lines, "OK — gate passed."] };
  if (!emergency) return { ok: false, overridden: false, needsPhrase: false, lines: [...lines, "MANA (REFUSED) — CI/SQL not green on this sha."] };
  if (typed === null) return { ok: false, overridden: false, needsPhrase: true, lines };
  if (String(typed).trim() !== overridePhrase(sha))
    return { ok: false, overridden: false, needsPhrase: false, lines: [...lines, "MANA (REFUSED) — confirmation phrase did not match."] };
  return { ok: true, overridden: true, needsPhrase: false, lines: [...lines, "⚠ EMERGENCY OVERRIDE — CI/SQL gate skipped by typed confirmation (logged)."] };
}

/** One JSON line for the override log. */
export function overrideLogLine({ sha, lines, now = new Date(), user = os.userInfo().username }) {
  return JSON.stringify({ at: now.toISOString(), user, sha, failed: lines.filter((l) => l.startsWith("✗")) }) + "\n";
}

/**
 * Runs the gate with injectable side effects (tests mock all of them):
 *   deps.exec(cmd, args) → stdout string; deps.ask(question) → Promise<string>; deps.log(line); deps.appendLog(text)
 */
export async function runGate(args, deps) {
  const sha = deps.exec("git", ["rev-parse", "--verify", `${args.sha ?? "HEAD"}^{commit}`]).trim();
  deps.exec("git", ["fetch", "-q", REMOTE]);
  const porcelain = deps.exec("git", ["status", "--porcelain"]);
  const remoteBranches = deps.exec("git", ["branch", "-r", "--contains", sha]);
  const runs = parseRuns(
    deps.exec("gh", ["run", "list", "-R", REPO, "--commit", sha, "--json", "workflowName,status,conclusion", "--limit", "50"]),
  );
  const facts = { sha, porcelain, remoteBranches, runs, emergency: args.emergency };
  let v = decide(facts);
  if (v.needsPhrase) {
    for (const l of v.lines) deps.log(l);
    deps.log(`\nEMERGENCY: to ship ${sha.slice(0, 8)} without green CI, type exactly:  ${overridePhrase(sha)}`);
    const typed = await deps.ask("> ");
    v = decide({ ...facts, typed });
    if (v.overridden && !args.dryRun) deps.appendLog(overrideLogLine({ sha, lines: v.lines }));
    v = { ...v, lines: v.lines.slice(-1) };
  }
  for (const l of v.lines) deps.log(l);
  if (args.dryRun) deps.log(`(dry-run) ${v.ok ? "would ship" : "would NOT ship"} ${sha} via Cloud Build — nothing pushed.`);
  return { ...v, sha };
}

/* ───────────── real side effects — not covered by unit tests ───────────── */

function realDeps() {
  return {
    exec: (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    ask: (q) =>
      new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(q, (a) => {
          rl.close();
          resolve(a);
        });
      }),
    log: (l) => console.log(l),
    appendLog: (text) => {
      mkdirSync(path.dirname(OVERRIDE_LOG), { recursive: true });
      appendFileSync(OVERRIDE_LOG, text);
      console.log(`(override logged to ${OVERRIDE_LOG})`);
    },
  };
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
    console.log("node scripts/ops/deploy-gate.mjs [<sha>] [--dry-run] [--emergency]");
    return;
  }
  let v;
  try {
    v = await runGate(args, realDeps());
  } catch (e) {
    console.error(`✗ Gate could not read git/gh (${e.message.split("\n")[0]}) — refusing.`);
    process.exit(1);
  }
  if (v.ok) console.log(`SHA=${v.sha}`);
  process.exit(v.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
