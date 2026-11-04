#!/usr/bin/env node
/**
 * `npm run localhost:ready` — make localhost ready for a Chrome check of built cards, in one command (R-2457).
 *
 *   npm run localhost:ready                       (from C:/Users/mso50/reselleros-deploy/production)
 *   npm run localhost:ready -- --dry-run          prints what it would do; kills/starts/applies nothing
 *   npm run localhost:ready -- --no-restart       never kills the server (reports hung instead)
 *   npm run localhost:ready -- --warm /quotes,/accounting/banking   pages to pre-compile after sign-in
 *
 * Steps (logic + tests: localhost-ready-lib.mjs, tests/ops/localhost-ready.test.ts):
 *   1. Local Supabase DB container not running → `npx supabase start`. Then the LOCAL GUARD
 *      (scripts/dev/local-guard.mjs): NODE_ENV production, a non-local `supabase status` URL or a
 *      non-local DATABASE/SUPABASE URL in the shell env → refuse, nothing touched. No override.
 *   2. `localhost:update` (R-2106): code → newest anutech/manager-pardeep, every pending migration on
 *      the LOCAL DB. It refuses a checkout on a branch, so a worker worktree is never moved.
 *   3. Probe http://localhost:<port>/api/version (public, no DB). Hung = the port LISTENS but 3 probes
 *      of 30 s get no answer (4 Nov: 4+ min). Only then — or when localhost:update changed a file that
 *      needs a restart — it kills the process tree of OUR dev server (the listener must be node running
 *      next dev / dev-local.mjs; anything else → refused) with `taskkill /T /F`, and starts
 *      `node scripts/dev-local.mjs -p <port>` detached (log in the temp folder). 5xx → reported, no kill.
 *   4. Local test login: POST /api/dev/test-login {role} — the app's own local-only route holds the test
 *      password (never this script, never printed). Fails → the seed hint.
 *   5. Warms the pages with that session, prints ONE line: READY … / NOT READY — <reason>.
 *
 * Never touches staging/live, never prints a key, cookie or password.
 * Exit: 0 READY · 1 refused by the local guard / bad args · 2 NOT READY.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseSupabaseStatus } from "../dev/local-guard.mjs";
import {
  parseReadyArgs, runReady, localGuardReason, parseNetstatListeners, parseProcessList, EXIT_READY,
} from "./localhost-ready-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const productionDir = path.resolve(here, "..", "..");
const win = process.platform === "win32";

function sh(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, maxBuffer: 32 * 1024 * 1024, ...opts });
  } catch { return ""; }
}

function dbContainer() {
  return sh("docker", ["ps", "--format", "{{.Names}}"], { timeout: 20_000 }).split(/\r?\n/).map((s) => s.trim()).find((n) => /^supabase_db_/.test(n)) ?? null;
}

function supabaseStatus() {
  const r = spawnSync("npx supabase status -o env", { cwd: productionDir, encoding: "utf8", shell: true, timeout: 120_000 });
  const s = parseSupabaseStatus(`${r.stdout ?? ""}`);
  return s.url && s.dbUrl ? { url: s.url, dbUrl: s.dbUrl } : null;
}

function listeners(port) {
  if (win) return parseNetstatListeners(sh("netstat", ["-ano", "-p", "TCP"]) + sh("netstat", ["-ano", "-p", "TCPv6"]), port);
  return sh("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).split(/\s+/).filter(Boolean).map(Number);
}

/** Windows only (the coordinator's laptop). Elsewhere → empty map → pickKillTarget refuses to kill. */
function processes() {
  if (!win) return new Map();
  const ps = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  return parseProcessList(sh("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 60_000 }));
}

function ancestorsOf(pid, procs) {
  const out = [];
  let cur = procs.get(pid);
  for (let i = 0; cur && i < 20; i++) { out.push(cur.ppid); cur = procs.get(cur.ppid); }
  return out;
}

function kill(pid) {
  if (!win) { try { process.kill(-pid, "SIGTERM"); return true; } catch { try { process.kill(pid, "SIGTERM"); return true; } catch { return false; } } }
  const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8" });
  return r.status === 0;
}

function start(port) {
  const log = path.join(os.tmpdir(), `localhost-${port}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  const fd = fs.openSync(log, "a");
  const child = spawn(process.execPath, [path.join("scripts", "dev-local.mjs"), "-p", String(port)], {
    cwd: productionDir, detached: true, stdio: ["ignore", fd, fd], windowsHide: true,
  });
  child.unref();
  return { pid: child.pid, log };
}

async function probe(url, timeoutMs) {
  const t = Date.now();
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    await res.arrayBuffer().catch(() => {});
    return { ok: res.status < 500, status: res.status, ms: Date.now() - t };
  } catch (e) {
    const name = e && typeof e === "object" && "name" in e ? String(e.name) : "";
    return { ok: false, error: name === "TimeoutError" ? `no answer in ${Math.round(timeoutMs / 1000)} s` : String(e?.cause?.code ?? e?.message ?? e).slice(0, 80) };
  }
}

async function testLogin(base, role) {
  try {
    const res = await fetch(`${base}/api/dev/test-login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role }),
      signal: AbortSignal.timeout(180_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, error: String(body?.error ?? "").slice(0, 200) };
    const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    return { ok: true, status: res.status, cookie };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 120) };
  }
}

async function warmPage(p, base, cookie) {
  const t = Date.now();
  try {
    const res = await fetch(`${base}${p}`, { redirect: "manual", headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(180_000) });
    await res.arrayBuffer().catch(() => {});
    return { status: res.status, ms: Date.now() - t };
  } catch { return { status: "timeout", ms: Date.now() - t }; }
}

function update({ dryRun }) {
  const r = spawnSync(process.execPath, [path.join("scripts", "ops", "localhost-update.mjs"), ...(dryRun ? ["--dry-run"] : [])], {
    cwd: productionDir, encoding: "utf8", timeout: 900_000, maxBuffer: 64 * 1024 * 1024,
  });
  const lines = `${r.stdout ?? ""}${r.stderr ?? ""}`.split(/\r?\n/).filter((l) => l.trim());
  return { code: r.status ?? 1, lines };
}

async function main(argv) {
  let args;
  try { args = parseReadyArgs(argv); } catch (e) { console.error(`✗ ${e.message}`); process.exit(EXIT_READY.refused); }
  if (args.help) { console.log("npm run localhost:ready [-- --dry-run] [--no-restart] [--no-update] [--port 3001] [--warm /a,/b] [--role owner]"); return; }
  console.log(`localhost:ready → ${productionDir}${args.dryRun ? "  (dry-run: kuch nahi badlega)" : ""}`);
  const r = await runReady({
    args,
    print: (l) => console.log(l),
    now: () => Date.now(),
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    selfPid: process.pid,
    selfAncestors: (procs) => ancestorsOf(process.pid, procs),
    guard: () => localGuardReason({ env: process.env, status: supabaseStatus(), container: dbContainer() }),
    dbContainer,
    startDb: () => spawnSync("npx supabase start", { cwd: productionDir, stdio: "inherit", shell: true, timeout: 900_000 }).status === 0,
    update,
    listeners,
    processes,
    probe,
    kill,
    start,
    testLogin,
    warmPage,
  });
  process.exit(r.code);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
