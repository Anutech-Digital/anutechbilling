#!/usr/bin/env node
/**
 * Staging gate — R-332 (7 Oct 2026). Manager runs this before EVERY staging merge and live deploy.
 *
 * Why: research found staging/live merges never looked at GitHub CI, and the Cloud Build gate
 * has no lint and builds the image with SKIP_BUILD_TYPECHECK=1. So a SHA with red CI could reach
 * staging and then live. This script refuses unless CI on that exact SHA finished green.
 *
 *   node scripts/ops/staging-gate.mjs                 CI check for HEAD of anutech/manager-pardeep
 *   node scripts/ops/staging-gate.mjs <sha>           CI check for that SHA
 *   node scripts/ops/staging-gate.mjs [<sha>] --local also the full local gate, one after another:
 *                                                      vitest, lint, lint:ratchet, next build
 *
 * Exit 0 = merge allowed. Exit 1 = refused (message says why). Run from production/.
 * --local runs `next build`, which wipes .next — stop the dev server first (see scripts/gate.mjs).
 */
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const REPO = "Anutech-Digital/anutechbilling";
export const REMOTE = "anutech";
export const BRANCH = "manager-pardeep";
export const WORKFLOW = "CI";

/** Sequential on purpose: run in parallel they fight over RAM and .next (see scripts/gate.mjs). */
export const LOCAL_STEPS = [
  { name: "vitest", cmd: "npx", args: ["vitest", "run"] },
  { name: "lint", cmd: "npm", args: ["run", "lint"] },
  { name: "lint:ratchet", cmd: "npm", args: ["run", "lint:ratchet"] },
  { name: "build", cmd: "npm", args: ["run", "build"] },
];

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** argv (without node + script) → { sha, local, help }. sha null = HEAD of anutech/manager-pardeep. */
export function parseArgs(argv) {
  const out = { sha: null, local: false, help: false };
  for (const a of argv) {
    if (a === "--local") out.local = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("-")) throw new Error(`Unknown flag ${a} (sirf --local / --help)`);
    else if (SHA_RE.test(a)) out.sha = a;
    else throw new Error(`"${a}" commit SHA nahi hai — pass a commit SHA (7-40 hex chars)`);
  }
  return out;
}

/** `gh run list --json conclusion,status` output → array of runs (newest first, as gh returns). */
export function parseRuns(text) {
  const s = String(text ?? "").trim();
  if (!s) return [];
  const data = JSON.parse(s);
  if (!Array.isArray(data)) throw new Error("gh output is not a JSON array");
  return data.map((r) => ({ status: String(r.status ?? ""), conclusion: String(r.conclusion ?? "") }));
}

/** Runs for one SHA → { ok, message }. Only the NEWEST run counts: a red re-run beats an old green. */
export function ciDecision(runs, sha) {
  const short = String(sha).slice(0, 8);
  if (!runs.length) {
    return {
      ok: false,
      message: `✗ ${short}: GitHub par CI run nahi mila (no CI run for this SHA). Pehle push karo aur CI ka intezaar karo — merge mat karo.`,
    };
  }
  const { status, conclusion } = runs[0];
  if (status !== "completed") {
    return {
      ok: false,
      message: `✗ ${short}: CI abhi chal raha hai (${status || "unknown"}; still running). Khatam hone do, phir dobara chalao — abhi merge mat karo.`,
    };
  }
  if (conclusion !== "success") {
    return {
      ok: false,
      message: `✗ ${short}: CI laal hai (${conclusion || "no conclusion"}). Pehle CI theek karo — staging/live merge mat karo (do not merge).`,
    };
  }
  return { ok: true, message: `✓ ${short}: GitHub CI hara (completed + success).` };
}

/** CI decision + local step results → { ok, text } for the final summary. */
export function summarize(sha, ci, steps) {
  const bad = steps.filter((s) => !s.ok).map((s) => s.name);
  const ok = ci.ok && bad.length === 0;
  const lines = [`staging gate — ${String(sha).slice(0, 8)}`, `  CI     ${ci.ok ? "ok  " : "FAIL"}  ${ci.message}`];
  for (const s of steps) lines.push(`  local  ${s.ok ? "ok  " : "FAIL"}  ${s.name.padEnd(13)} ${String(s.secs).padStart(4)}s`);
  lines.push(
    ok
      ? "OK — staging merge / live deploy allowed."
      : `MANA (REFUSED) — ${[!ci.ok && "CI", ...bad].filter(Boolean).join(", ")} hara nahi. Merge mat karo.`,
  );
  return { ok, text: lines.join("\n") };
}

/* ───────────── side effects below — not covered by unit tests (no network in tests) ───────────── */

function resolveSha(sha) {
  if (sha) return execFileSync("git", ["rev-parse", sha], { encoding: "utf8" }).trim();
  execFileSync("git", ["fetch", "-q", REMOTE, BRANCH], { stdio: "inherit" });
  return execFileSync("git", ["rev-parse", `${REMOTE}/${BRANCH}`], { encoding: "utf8" }).trim();
}

function fetchRuns(sha) {
  const out = execFileSync(
    "gh",
    ["run", "list", "--repo", REPO, "--commit", sha, "--workflow", WORKFLOW, "--json", "conclusion,status"],
    { encoding: "utf8" },
  );
  return parseRuns(out);
}

function runStep(step) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    console.log(`… ${step.name}`);
    /* shell: true — npm/npx are .cmd files on Windows. Args are fixed in this file. */
    const p = spawn(step.cmd, step.args, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => {
      const secs = Math.round((Date.now() - t0) / 1000);
      const ok = code === 0;
      if (!ok) {
        const lines = out.split(/\r?\n/).filter((l) => /error|Error|✗|×|FAIL|failed/.test(l));
        console.log((lines.length ? lines.slice(0, 20) : out.split(/\r?\n/).slice(-20)).join("\n"));
      }
      resolve({ name: step.name, ok, secs });
    });
  });
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
    console.log("node scripts/ops/staging-gate.mjs [<sha>] [--local]");
    return;
  }

  let sha, ci;
  try {
    sha = resolveSha(args.sha);
    ci = ciDecision(fetchRuns(sha), sha);
  } catch (e) {
    console.error(`✗ CI status nahi padh paye (gh/git error) — merge mat karo.\n${e.message}`);
    process.exit(1);
  }
  console.log(ci.message);

  const steps = [];
  /* Red CI already refuses — no point spending ~3 min on the local gate. */
  if (ci.ok && args.local) {
    for (const step of LOCAL_STEPS) {
      const r = await runStep(step);
      steps.push(r);
      if (!r.ok) break; // refuse on the first failure
    }
  }

  const s = summarize(sha, ci, steps);
  console.log(`\n${s.text}`);
  process.exit(s.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
