/**
 * migrations-health-check — after a deploy, ask the app itself whether every migration it was
 * built with is on its DB (R-1721, 21 Oct 2026).
 *
 * 21 Oct: the staging DB step stopped after its backup (gcloud login expired), an old "DB READY"
 * was taken as done, the train ran with --db-done, and new code ran on staging ~1 hour without 4
 * migrations. The train trusted a person. Now, after the push:
 *   1. wait until GET /api/version shows the pushed commit — compared on 7 characters (Cloud
 *      Build's $SHORT_SHA; 21 Oct an 8-character compare never matched → TIMEOUT)
 *   2. GET /api/health/migrations with `Authorization: Bearer $MIGRATIONS_HEALTH_TOKEN`
 *   3. ok → green "✓ Sab migrations DB par"; missing → red "DB step chhoot gaya: <keys>", exit 5;
 *      could not check (no token here, 401/503, build never came) → yellow, never silent.
 *
 * staging-train.mjs --push calls this by itself. For live (or a re-check of staging):
 *   node scripts/ops/migrations-health-check.mjs --url https://reselleros.anutech.in [--sha <pushed sha>]
 *
 * Token: env MIGRATIONS_HEALTH_TOKEN, else the file ~/.claude/secrets/migrations-health-token
 * (written by scripts/ops/migrations-health-token.sh). Never printed.
 * Exit 0 = all there. 4 = could not check (with a token). 5 = migrations missing. Run from production/.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TOKEN_ENV = "MIGRATIONS_HEALTH_TOKEN";
export const TOKEN_FILE = path.join(os.homedir(), ".claude", "secrets", "migrations-health-token");
export const STAGING_URL = "https://resellersos-staging-njvk4nxhdq-as.a.run.app";
export const SHA_LEN = 7;

const C = { red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", off: "\x1b[0m" };

/** Is the app's build (7-char $SHORT_SHA) the pushed commit? Both cut to 7 — never 8. */
export function sameBuild(appSha, pushedSha) {
  const a = String(appSha ?? "").trim().toLowerCase();
  const p = String(pushedSha ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(a) || !/^[0-9a-f]{7,40}$/.test(p)) return false;
  return a.slice(0, SHA_LEN) === p.slice(0, SHA_LEN);
}

/** env first, then the token file. `readFile` returns the file's text or null. */
export function readToken(env = process.env, readFile = () => (fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, "utf8") : null)) {
  const v = env[TOKEN_ENV]?.trim() || readFile()?.trim();
  return v || null;
}

const trimBase = (b) => String(b).replace(/\/+$/, "");

/** Poll /api/version until it shows `sha`. → { arrived, lastSha } */
export async function waitForBuild({ base, sha, fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, timeoutMs = 25 * 60_000, intervalMs = 30_000, onTick = () => {} }) {
  const start = now();
  let lastSha = null;
  for (;;) {
    try {
      const res = await fetchFn(`${trimBase(base)}/api/version`, { headers: { "cache-control": "no-cache" } });
      if (res.ok) lastSha = (await res.json())?.sha ?? null;
    } catch {
      /* a cold start or a deploy in flight — keep polling */
    }
    if (sameBuild(lastSha, sha)) return { arrived: true, lastSha };
    if (now() - start >= timeoutMs) return { arrived: false, lastSha };
    onTick(lastSha);
    await sleep(intervalMs);
  }
}

/** One call to the endpoint. → { kind: "result", status, body } | { kind: "network", error } */
export async function checkMigrations({ base, token, fetchFn = fetch }) {
  try {
    const res = await fetchFn(`${trimBase(base)}/api/health/migrations`, { headers: { authorization: `Bearer ${token}` } });
    let body = {};
    try { body = await res.json(); } catch { /* non-JSON → treated as could-not-check */ }
    return { kind: "result", status: res.status, body };
  } catch (e) {
    return { kind: "network", error: e instanceof Error ? e.message : String(e) };
  }
}

/** → { level: ok|missing|unchecked, exitCode, message } */
export function verdict(r) {
  const unchecked = (why, exitCode = 4) => ({ level: "unchecked", exitCode, message: `migration jaanch nahi ho saki — ${why}` });
  if (r.kind === "no-token") return unchecked(`is computer par ${TOKEN_ENV} nahi mila (env ya ${TOKEN_FILE}). Pardeep: scripts/ops/migrations-health-token.sh chalao.`, 0);
  if (r.kind === "timeout") return unchecked(`naya build ${r.lastSha ? `nahi aaya (app abhi bhi ${r.lastSha} dikha rahi hai)` : "ka /api/version jawab nahi de raha"}. Cloud Build dekho, phir: node scripts/ops/migrations-health-check.mjs --url <url>`);
  if (r.kind === "network") return unchecked(`app tak pahunch nahi paaye (${r.error}).`);
  if (r.status === 401) return unchecked("app ne token nahi maana (401) — app par aur is computer par MIGRATIONS_HEALTH_TOKEN alag hai.");
  if (r.status === 503 && r.body?.error) return unchecked("app par MIGRATIONS_HEALTH_TOKEN set nahi hai (503) — Pardeep ka step.");
  if (r.status !== 200) return unchecked(`app apna DB nahi padh saki (HTTP ${r.status}).`);
  const missing = Array.isArray(r.body?.missing) ? r.body.missing : null;
  if (r.body?.ok === true && missing?.length === 0) return { level: "ok", exitCode: 0, message: "✓ Sab migrations DB par" };
  if (missing?.length) return { level: "missing", exitCode: 5, message: `DB step chhoot gaya: ${missing.join(", ")}` };
  return unchecked("app ka jawab samajh nahi aaya.");
}

export function colour(v) {
  const c = v.level === "ok" ? C.green : v.level === "missing" ? C.red : C.yellow;
  return `${c}${v.message}${C.off}`;
}

/** Wait for `sha` (when given), then check. Prints as it goes; returns the verdict. */
export async function runCheck({ base, sha, log = console.log, ...opts }) {
  const token = readToken(opts.env, opts.readFile);
  if (!token) return verdict({ kind: "no-token" });
  if (sha) {
    log(`Naye build ka intezaar: ${trimBase(base)}/api/version = ${String(sha).slice(0, SHA_LEN)} …`);
    const w = await waitForBuild({ base, sha, ...opts, onTick: (s) => log(`  abhi ${s ?? "jawab nahi"} — 30 s baad dobara`) });
    if (!w.arrived) return verdict({ kind: "timeout", lastSha: w.lastSha });
    log(`✓ Naya build aa gaya (${w.lastSha}).`);
  }
  return verdict(await checkMigrations({ base, token, fetchFn: opts.fetchFn }));
}

async function main(argv) {
  let base = STAGING_URL, sha = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url") base = argv[++i];
    else if (argv[i] === "--sha") sha = argv[++i];
    else { console.error(`Unknown argument ${argv[i]} (sirf --url / --sha)`); process.exit(1); }
  }
  const v = await runCheck({ base, sha });
  console.log(colour(v));
  process.exit(v.exitCode);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv.slice(2));
