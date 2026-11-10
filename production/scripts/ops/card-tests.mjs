#!/usr/bin/env node
/**
 * card-tests.mjs — run a board card's check as a Playwright test on LOCALHOST (R-2550, 7 Nov 2026).
 *
 * Pardeep: "jab testing baar baar hoti hai ek badiya sa system kyo nahi bana lete". A card's
 * howToCheck is written ONCE as e2e/cards/<card id>.spec.ts (one test per step); this runs it
 * in about a minute, prints ✓ / ✗ / – per step with seconds, and saves the result as JSON for
 * the board (browserCheck on the card — the Claude session writes it with ArtifactData).
 *
 *   node scripts/ops/card-tests.mjs R-1001            # one card
 *   node scripts/ops/card-tests.mjs R-1001 R-1003     # several
 *   node scripts/ops/card-tests.mjs                   # every spec in e2e/cards
 *   BASE_URL=http://127.0.0.1:3001 node scripts/ops/card-tests.mjs R-1001
 *
 * LOCALHOST ONLY. BASE_URL may be localhost / 127.0.0.1 / [::1]; staging, run.app, anutech.in
 * or any other host is refused before anything runs. Logins use the Local test login
 * (POST /api/dev/test-login), which exists only on `npm run dev:local` — no password is read
 * here. Needs the local app running (on Pardeep's laptop: reselleros-deploy on :3001); this
 * script never starts or stops a server.
 *
 * Result files: <home>/Anutech-HQ/card-tests/<card>-<timestamp>.json (CARD_TESTS_OUT overrides).
 * Exit: 0 every card passed (≥1 step ran, none failed) · 1 a step failed, a load error, or
 * nothing ran · 2 refused / bad input / app not reachable.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROD = path.resolve(HERE, "../..");
const CARDS_DIR = path.join(PROD, "e2e", "cards");
export const DEFAULT_BASE = "http://localhost:3001";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Why `base` must not be used, or null when it is a local app URL.
 * Only http(s)://localhost | 127.0.0.1 | [::1] pass; named hosts get a specific message.
 */
export function hostRefusal(base) {
  let u;
  try {
    u = new URL(String(base ?? ""));
  } catch {
    return `BASE_URL "${base}" is not a URL — use e.g. ${DEFAULT_BASE}.`;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return `BASE_URL must be http(s), got ${u.protocol}`;
  const host = u.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host)) return null;
  const kind = /staging/.test(host) ? "staging"
    : /\.run\.app$/.test(host) ? "a Cloud Run (staging/live) app"
    : /(^|\.)anutech\.in$/.test(host) ? "the live Anutech site"
    : /(^|\.)(supabase\.co|vercel\.app)$/.test(host) ? "a hosted (production) service"
    : "not localhost";
  return `Card tests run ONLY on localhost — ${host} is ${kind}. Refused; nothing was run. ` +
    `Use ${DEFAULT_BASE} (or 127.0.0.1 / [::1]).`;
}

/** Card ids from argv; throws on anything that is not R-<digits>. */
export function parseCards(argv) {
  const ids = argv.filter((a) => !a.startsWith("--"));
  for (const id of ids) if (!/^R-\d+$/.test(id)) throw new Error(`"${id}" is not a card id (R-1234).`);
  return ids;
}

/** Every card that has a spec in e2e/cards. */
export function allCards(dir = CARDS_DIR) {
  return fs.readdirSync(dir).filter((f) => /^R-\d+\.spec\.ts$/.test(f)).map((f) => f.replace(".spec.ts", ""))
    .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
}

/**
 * Playwright JSON report → per-step rows. One test = one step; status passed / failed /
 * skipped (with the skip reason) and seconds.
 */
export function stepsFromReport(report) {
  const out = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const results = t.results ?? [];
        const last = results[results.length - 1] ?? {};
        // The test OUTCOME decides (expected / flaky = passed, skipped, unexpected = failed);
        // a test with no result at all never ran — that is a failure, never a "skip".
        const status = !results.length ? "failed"
          : t.status === "skipped" ? "skipped"
          : t.status === "expected" || t.status === "flaky" ? "passed" : "failed";
        const notes = (t.annotations ?? []).filter((a) => a.description).map((a) => `${a.type}: ${a.description}`);
        const error = status !== "failed" ? undefined
          : !results.length ? "did not run (the run stopped before this step)"
          : firstLine(last.error?.message ?? last.errors?.[0]?.message ?? "") || `ended as ${last.status ?? "unknown"}`;
        out.push({ step: spec.title, status, seconds: round1((last.duration ?? 0) / 1000), notes, ...(error ? { error } : {}) });
      }
    }
    for (const s of suite.suites ?? []) walk(s);
  };
  for (const s of report?.suites ?? []) walk(s);
  return out;
}

function firstLine(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\u001b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join(" | ").slice(0, 400);
}
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Overall verdict for the board: fail if any step failed or Playwright reported a load/run error
 * (a spec that does not compile has no steps); pass if ≥1 passed and none failed; else not-run.
 */
export function verdict(steps, runErrors = []) {
  if (runErrors.length || steps.some((s) => s.status === "failed")) return "fail";
  if (steps.some((s) => s.status === "passed")) return "pass";
  return "not-run";
}

/** The browserCheck object the session writes on the board card. */
export function browserCheckFor(run) {
  const n = (st) => run.steps.filter((s) => s.status === st).length;
  const skipped = run.steps.filter((s) => s.status === "skipped").map((s) => s.step.split(":")[0]);
  const failed = run.steps.filter((s) => s.status === "failed").map((s) => s.step.split(":")[0]);
  return {
    env: "local",
    by: "card-test",
    at: run.finishedAt,
    result: run.result,
    note: `${n("passed")} ✓ · ${n("failed")} ✗ · ${n("skipped")} skip in ${run.seconds}s on ${run.baseUrl}` +
      (failed.length ? ` — failed: ${failed.join(", ")}` : "") +
      (skipped.length ? ` — skipped (machine can't): ${skipped.join(", ")}` : "") +
      ` (node scripts/ops/card-tests.mjs ${run.card})`,
  };
}

const outDir = () => process.env.CARD_TESTS_OUT || path.join(os.homedir(), "Anutech-HQ", "card-tests");
const stamp = (d) => d.toISOString().replace(/[:.]/g, "-");

async function reachable(base) {
  try {
    const res = await fetch(new URL("/login", base), { redirect: "manual", signal: AbortSignal.timeout(60_000) }); // a busy dev server can take this long
    return res.status < 500;
  } catch {
    return false;
  }
}

function runCard(card, base) {
  const spec = path.join(CARDS_DIR, `${card}.spec.ts`);
  if (!fs.existsSync(spec)) {
    return { card, error: `No card test yet: e2e/cards/${card}.spec.ts — write it from the card's howToCheck (docs/WORKER-STEPS.md).` };
  }
  const jsonFile = path.join(os.tmpdir(), `card-test-${card}-${process.pid}-${Date.now()}.json`);
  const started = new Date();
  // Playwright's own CLI through node — no shell, so a timeout kills the runner itself
  // (on Windows a shell would be killed and leave the runner + Chromium behind).
  const cli = path.join(PROD, "node_modules", "@playwright", "test", "cli.js");
  const r = spawnSync(process.execPath, [
    cli, "test", `e2e/cards/${card}.spec.ts`,
    "--project=chromium", "--workers=1", "--reporter=json", "--retries=0",
    // A cold `next dev` compiles each page on first open (20–60 s); the config's 30 s is too short.
    "--timeout=180000",
  ], {
    cwd: PROD,
    encoding: "utf8",
    env: {
      ...process.env,
      CARD_TESTS: "1",
      PLAYWRIGHT_BASE_URL: base, // also turns off playwright.config's own webServer
      PLAYWRIGHT_JSON_OUTPUT_NAME: jsonFile,
      CI: "",
    },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60_000,
  });
  const finished = new Date();
  let report = null;
  try { report = JSON.parse(fs.readFileSync(jsonFile, "utf8")); } catch { /* reported below */ }
  try { fs.rmSync(jsonFile, { force: true }); } catch { /* temp file */ }
  if (!report) {
    return { card, error: `Playwright gave no report (exit ${r.status}). ${firstLine(r.stderr || r.stdout || r.error?.message || "")}` };
  }
  const steps = stepsFromReport(report);
  const seconds = round1((finished - started) / 1000);
  const reportErrors = (report.errors ?? []).map((e) => firstLine(e.message ?? "")).filter(Boolean);
  if (r.status !== 0 && !steps.some((s) => s.status === "failed") && !reportErrors.length) {
    reportErrors.push(`Playwright exited ${r.status ?? r.signal ?? "?"} with no failed step`);
  }
  const run = {
    card, baseUrl: base, startedAt: started.toISOString().replace(/\.\d+Z$/, "Z"),
    finishedAt: finished.toISOString().replace(/\.\d+Z$/, "Z"), seconds, result: verdict(steps, reportErrors), steps,
    reportErrors,
  };
  run.browserCheck = browserCheckFor(run);
  return run;
}

function print(run) {
  if (run.error) {
    console.log(`✗ ${run.card}: ${run.error}`);
    return;
  }
  const icon = { passed: "✓", failed: "✗", skipped: "–" };
  console.log(`\n${run.result === "pass" ? "✓" : run.result === "fail" ? "✗" : "–"} ${run.card} — ${run.result.toUpperCase()} in ${run.seconds}s (${run.baseUrl})`);
  for (const s of run.steps) {
    console.log(`  ${icon[s.status]} ${s.step}  (${s.seconds}s)`);
    if (s.error) console.log(`      ${s.error}`);
    for (const n of s.notes) console.log(`      ${n}`);
  }
  for (const e of run.reportErrors) console.log(`  ! ${e}`);
}

async function main(argv) {
  let cards;
  try {
    cards = parseCards(argv);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    return 2;
  }
  const base = (process.env.BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
  const refusal = hostRefusal(base);
  if (refusal) {
    console.error(`✗ ${refusal}`);
    return 2;
  }
  if (!cards.length) cards = allCards();
  if (!cards.length) {
    console.error("✗ No card tests in e2e/cards yet.");
    return 2;
  }
  if (!(await reachable(base))) {
    console.error(`✗ ${base} is not answering — start the local app (npm run dev:local) first; this script never starts one.`);
    return 2;
  }
  const dir = outDir();
  fs.mkdirSync(dir, { recursive: true });
  let failed = false;
  for (const card of cards) {
    const run = runCard(card, base);
    print(run);
    // Only a run where steps really passed is a success — "not-run" (all skipped / none found) is not.
    if (run.error || run.result !== "pass") failed = true;
    if (!run.error) {
      const file = path.join(dir, `${card}-${stamp(new Date(run.finishedAt))}.json`);
      fs.writeFileSync(file, JSON.stringify(run, null, 2));
      console.log(`  → ${file}`);
      console.log(`  browserCheck: ${JSON.stringify(run.browserCheck)}`);
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
