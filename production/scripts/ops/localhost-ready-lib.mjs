/**
 * R-2457 — the logic behind `npm run localhost:ready` (CLI: localhost-ready.mjs). Pure helpers and a
 * run whose side effects (git, docker, ports, processes, HTTP) are all injected, so the tests prove the
 * hung-server path without touching a real server.
 *
 * Why (4 Nov 2026 morning, checking 27 built cards in Chrome): the :3001 dev server was LISTENING but
 * gave no answer for 4+ minutes and had to be killed by hand; the local DB missed merged migrations
 * until localhost:update ran; Chrome was not signed in. One command now: local guard → (start the local
 * DB if it is down) → localhost:update (code + migrations) → probe → kill + restart ONLY our own hung
 * `next dev` → test-login check → warm pages → one READY / NOT READY line.
 */
import { dbUrlLocalReason, scenarioTargetReason } from "../dev/local-guard.mjs";

export const EXIT_READY = { ready: 0, refused: 1, notReady: 2 };

/** Pages warmed after sign-in so the first Chrome click does not wait on a first compile. */
export const DEFAULT_WARM = ["/dashboard", "/quotes", "/invoices", "/customers", "/accounting/banking"];

/* ───────────── parsing ───────────── */

/** `netstat -ano` text → pids LISTENING on exactly `port` (IPv4 or IPv6). */
export function parseNetstatListeners(text, port) {
  const pids = new Set();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (!m) continue;
    const p = /:(\d+)$/.exec(m[1]);
    if (p && Number(p[1]) === Number(port)) pids.add(Number(m[2]));
  }
  return [...pids];
}

/**
 * PowerShell `Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,Name,CommandLine |
 * ConvertTo-Json -Compress` → Map pid → { pid, ppid, name, cmd }. Bad JSON → empty map.
 */
export function parseProcessList(json) {
  let rows;
  try { rows = JSON.parse(String(json ?? "")); } catch { return new Map(); }
  if (!Array.isArray(rows)) rows = rows ? [rows] : [];
  const out = new Map();
  for (const r of rows) {
    const pid = Number(r?.ProcessId);
    if (!Number.isFinite(pid)) continue;
    out.set(pid, { pid, ppid: Number(r?.ParentProcessId) || 0, name: String(r?.Name ?? ""), cmd: String(r?.CommandLine ?? "") });
  }
  return out;
}

/**
 * Command lines of OUR dev server's process tree: `npm run dev:local`, `node scripts/dev-local.mjs`,
 * `npx next dev`, next's own bin with `dev`, and next's dev worker (start-server / router-server).
 * Never `next build` / `next start`, never another node app.
 */
export function isOurDevServerCmd(cmd) {
  const c = String(cmd ?? "");
  if (!c.trim()) return false;
  return /\brun\s+dev:local\b/i.test(c)
    || /dev-local\.mjs\b/i.test(c)
    || /\bnext["']?\s+dev\b/i.test(c)
    || /[\\/]next[\\/]dist[\\/]bin[\\/]next["']?\s+dev\b/i.test(c)
    || /[\\/]next[\\/]dist[\\/]server[\\/]lib[\\/](start-server|router-server)\.js\b/i.test(c);
}

const SHELLS = new Set(["node.exe", "node", "cmd.exe"]);

/**
 * Which process to kill (with its tree) for a hung dev server on our port. The LISTENER must be a
 * node process whose command line is our dev server; then walk up the parents while they are still
 * node/cmd processes of the same dev server, and kill the topmost — so `npm run dev:local`'s whole
 * tree goes and nothing restarts a half. Never this script (selfPid) or anything above it.
 * → { ok: true, pid, chain } | { ok: false, reason }
 */
export function pickKillTarget({ listenerPid, procs, selfPid, selfAncestors = [] }) {
  const listener = procs.get(Number(listenerPid));
  if (!listener) return { ok: false, reason: `pid ${listenerPid} not found in the process list — not killing` };
  if (listener.pid === selfPid) return { ok: false, reason: "the listener is this script — not killing" };
  if (!/^node(\.exe)?$/i.test(listener.name) || !isOurDevServerCmd(listener.cmd)) {
    return { ok: false, reason: `pid ${listener.pid} (${listener.name}) is not our next dev / dev:local server — not killing (cmd: ${listener.cmd.slice(0, 160)})` };
  }
  const blocked = new Set([selfPid, ...selfAncestors].map(Number));
  const chain = [listener.pid];
  let cur = listener;
  for (let i = 0; i < 12; i++) {
    const parent = procs.get(cur.ppid);
    if (!parent || blocked.has(parent.pid)) break;
    if (!SHELLS.has(parent.name.toLowerCase()) || !isOurDevServerCmd(parent.cmd)) break;
    chain.push(parent.pid);
    cur = parent;
  }
  return { ok: true, pid: cur.pid, chain };
}

/**
 * Fallback when the process list cannot be read (4 Nov: PowerShell/WMI did not answer in 90 s on the
 * loaded laptop): the pid file localhost:ready wrote when IT started dev:local. Trusted only for the same
 * port and checkout, and only while that pid is still a node.exe (tasklist image) — else refuse.
 * → { ok: true, pid, chain, via: "pidfile" } | { ok: false, reason }
 */
export function pidFileTarget({ record, port, image, productionDir }) {
  if (!record || !Number.isInteger(record.pid) || record.pid <= 4) return { ok: false, reason: "process list unreadable and no localhost:ready pid file — not killing; stop the server by hand (Ctrl+C in its window), then run localhost:ready again" };
  if (Number(record.port) !== Number(port)) return { ok: false, reason: `pid file is for port ${record.port}, not ${port} — not killing` };
  if (productionDir && record.dir && path_eq(record.dir, productionDir) === false) return { ok: false, reason: `pid file is for ${record.dir}, not this checkout — not killing` };
  if (!/^node(\.exe)?$/i.test(String(image ?? ""))) return { ok: false, reason: `pid ${record.pid} from the pid file is no longer node (${image || "gone"}) — not killing` };
  return { ok: true, pid: record.pid, chain: [record.pid], via: "pidfile" };
}
const path_eq = (a, b) => String(a).replace(/\\/g, "/").toLowerCase() === String(b).replace(/\\/g, "/").toLowerCase();

/** `tasklist /FI "PID eq n" /FO CSV /NH` → image name ("node.exe") or null. */
export function parseTasklistImage(text) {
  const m = /^"([^"]+)","(\d+)"/m.exec(String(text ?? ""));
  return m ? m[1] : null;
}

/**
 * up: something answered below 500 · broken: it answers but only 5xx (Build Error — a restart does not
 * help) · hung: it LISTENS but no probe got an answer · down: nothing listens.
 */
export function classifyServer({ listening, probes }) {
  if (!listening) return "down";
  if (probes.some((p) => p && p.status != null && p.status < 500)) return "up";
  if (probes.some((p) => p && p.status != null && p.status >= 500)) return "broken";
  return "hung";
}

/**
 * Why this run must not touch anything (null = fine): NODE_ENV production, no local Supabase DB
 * container, a non-local `supabase status` URL, or a non-local database/Supabase URL in the shell env.
 * Reuses scripts/dev/local-guard.mjs (R-878/R-1957). No flag turns it off.
 */
export function localGuardReason({ env = {}, status, container }) {
  const base = scenarioTargetReason({
    nodeEnv: env.NODE_ENV,
    container,
    urls: ["DATABASE_URL", "DIRECT_URL", "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"].map((k) => env[k]),
  });
  if (base) return base;
  if (!status || !status.url || !status.dbUrl) return "`npx supabase status` gave no local API/DB URL — is the local stack running?";
  for (const u of [status.url, status.dbUrl]) {
    const why = dbUrlLocalReason(u);
    if (why) return `supabase status: ${why}`;
  }
  return null;
}

/** localhost:update printed that a changed file only takes effect on a dev-server restart. */
export function updateNeedsRestart(lines) {
  return (lines ?? []).some((l) => /restart par hi lagta hai/.test(String(l)));
}

export function parseReadyArgs(argv) {
  const out = {
    dryRun: false, port: 3001, restart: true, update: true, warm: DEFAULT_WARM,
    probeTimeoutMs: 30_000, probes: 3, startTimeoutMs: 300_000, role: "owner", help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run" || a === "--dry") out.dryRun = true;
    else if (a === "--port") out.port = Number(argv[++i]) || 3001;
    else if (a === "--no-restart") out.restart = false;
    else if (a === "--no-update") out.update = false;
    else if (a === "--warm") {
      const list = String(argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      for (const p of list) if (!/^\/[A-Za-z0-9/_\-.?=&]*$/.test(p) || p.startsWith("//")) throw new Error(`--warm takes app paths like /quotes, not "${p}"`);
      out.warm = list;
    } else if (a === "--probe-timeout") out.probeTimeoutMs = Math.max(1, Number(argv[++i]) || 30) * 1000;
    else if (a === "--start-timeout") out.startTimeoutMs = Math.max(10, Number(argv[++i]) || 300) * 1000;
    else if (a === "--role") out.role = String(argv[++i] ?? "owner");
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`Unknown argument ${a} (--dry-run / --port <n> / --no-restart / --no-update / --warm /a,/b / --probe-timeout <s> / --start-timeout <s> / --role owner)`);
  }
  return out;
}

/* ───────────── the run ───────────── */

/**
 * deps: print, now(), sleep(ms), selfPid, selfAncestors (pids, or procs → pids), guard() → reason|null, dbContainer() → name|null,
 * startDb() → bool, update({ dryRun }) → { code, lines }, listeners(port) → pids, processes() → Map,
 * probe(url, timeoutMs) → { ok, status?, ms?, error? }, kill(pid) → bool, start(port) → { pid, log },
 * testLogin(base, role) → { ok, status, cookie?, error? }, warmPage(path, base, cookie) → { status, ms }.
 */
export async function runReady({ args, ...d }) {
  const lines = [];
  const say = (l) => { lines.push(l); d.print?.(l); };
  const base = `http://localhost:${args.port}`;
  const t0 = d.now();
  const secs = () => Math.round((d.now() - t0) / 1000);
  let restarted = false;
  let state = "unknown";
  const result = (code, readyLine) => { say(readyLine); return { code, state, restarted, lines, readyLine }; };

  /* 1. local DB container (cold laptop) + guard */
  if (!d.dbContainer()) {
    if (args.dryRun) say("[dry-run] local Supabase DB container is not running — would run `npx supabase start`.");
    else {
      say("Local Supabase DB is not running — starting it (npx supabase start)…");
      if (!d.startDb() || !d.dbContainer()) return result(EXIT_READY.notReady, "NOT READY — local Supabase did not start (is Docker Desktop running?).");
    }
  }
  const why = d.guard();
  if (why) return result(EXIT_READY.refused, `NOT READY — refused, nothing touched: ${why}`);

  /* 2. code + migrations (the existing localhost:update) */
  let needRestart = false;
  if (args.update) {
    const u = d.update({ dryRun: args.dryRun });
    for (const l of u.lines) say(`  update │ ${l}`);
    if (u.code !== 0 && u.code !== 4) return result(EXIT_READY.notReady, `NOT READY — localhost:update stopped (exit ${u.code}); see its lines above.`);
    needRestart = updateNeedsRestart(u.lines);
  }

  /* 3. is the server there, and does it answer? */
  const probeUrl = `${base}/api/version`;
  const listenersNow = () => d.listeners(args.port);
  const probes = [];
  if (listenersNow().length) {
    for (let i = 0; i < args.probes; i++) {
      const p = await d.probe(probeUrl, args.probeTimeoutMs);
      probes.push(p);
      if (p.status != null) break;
    }
  }
  state = classifyServer({ listening: listenersNow().length > 0 || probes.length > 0, probes });
  const how = probes.length ? probes.map((p) => (p.status != null ? `${p.status} in ${p.ms ?? "?"} ms` : p.error ?? "no answer")).join(", ") : "nothing listens";
  say(`Server ${base}: ${state} (${how})`);

  if (state === "broken") return result(EXIT_READY.notReady, `NOT READY — ${base} answers only 5xx (a Build Error page?). A restart does not fix that: read the dev server window / its log.`);

  const mustRestart = state === "hung" || (state === "up" && needRestart);
  if (mustRestart) {
    if (state === "up") say("localhost:update changed a file the running server only reads at start → restart.");
    if (!args.restart) return result(EXIT_READY.notReady, `NOT READY — server is ${state}${state === "up" ? " but needs a restart" : ""}; --no-restart given, nothing killed.`);
    const procs = d.processes();
    const selfAncestors = typeof d.selfAncestors === "function" ? d.selfAncestors(procs) : (d.selfAncestors ?? []);
    const targets = [];
    if (procs.size === 0) {
      say("Process list could not be read (PowerShell/WMI) — falling back to localhost:ready's own pid file.");
      const t = d.pidFileTarget ? d.pidFileTarget(args.port) : { ok: false, reason: "no pid-file fallback" };
      if (!t.ok) return result(EXIT_READY.notReady, `NOT READY — ${t.reason}`);
      targets.push(t);
    } else {
      for (const pid of listenersNow()) {
        const t = pickKillTarget({ listenerPid: pid, procs, selfPid: d.selfPid, selfAncestors });
        if (!t.ok) return result(EXIT_READY.notReady, `NOT READY — ${t.reason}`);
        targets.push(t);
      }
    }
    for (const t of targets) {
      const cmd = procs.get(t.pid)?.cmd ?? "";
      if (args.dryRun) { say(`[dry-run] would kill pid ${t.pid} and its tree (${t.chain.join(" ← ")}): ${cmd.slice(0, 120)}`); continue; }
      say(`Killing our dev server tree: pid ${t.pid} (${t.chain.join(" ← ")})`);
      if (!d.kill(t.pid)) return result(EXIT_READY.notReady, `NOT READY — could not kill pid ${t.pid}.`);
    }
    if (args.dryRun) return result(EXIT_READY.notReady, `NOT READY [dry-run] — server ${state}; would restart dev:local on port ${args.port}.`);
    for (let i = 0; i < 20 && listenersNow().length; i++) await d.sleep(500);
    if (listenersNow().length) return result(EXIT_READY.notReady, `NOT READY — port ${args.port} is still taken after the kill.`);
    state = "down";
    restarted = true;
  }

  if (state === "down") {
    if (args.dryRun) return result(EXIT_READY.notReady, `NOT READY [dry-run] — nothing on port ${args.port}; would start dev:local.`);
    const s = d.start(args.port);
    say(`Started dev:local (pid ${s.pid}) — log: ${s.log}`);
    const until = d.now() + args.startTimeoutMs;
    let up = false;
    while (d.now() < until) {
      const p = await d.probe(probeUrl, args.probeTimeoutMs);
      if (p.status != null && p.status < 500) { up = true; say(`  answered ${p.status} after ${secs()} s`); break; }
      await d.sleep(5000);
    }
    if (!up) return result(EXIT_READY.notReady, `NOT READY — dev:local did not answer in ${Math.round(args.startTimeoutMs / 1000)} s; read ${s.log}.`);
    state = "up";
  }

  /* 4. Local test login works (no password here — the app's own /api/dev/test-login holds it) */
  if (args.dryRun) {
    say(`[dry-run] would sign in with Local test login (${args.role}) and warm ${args.warm.length} pages: ${args.warm.join(", ")}`);
    return result(EXIT_READY.ready, `READY [dry-run] ${base} — server up; login + warm skipped (a sign-in writes a session).`);
  }
  const login = await d.testLogin(base, args.role);
  if (!login.ok) {
    say(`Local test login (${args.role}) failed: ${login.status ?? ""} ${login.error ?? ""}`.trim());
    say("  Fix: seed the test users once — E2E_ALLOW_SEED=1 node e2e/fixtures/seed-e2e-tenant.mjs (local DB only), and keep production/.env.test.");
    return result(EXIT_READY.notReady, `NOT READY — server up, but Local test login (${args.role}) does not work.`);
  }
  say(`Local test login ${args.role}: ok → company "E2E Test Co" (what Chrome lands in after clicking the ${args.role} button).`);

  /* 5. warm pages */
  const warmed = [];
  for (const p of args.warm) {
    const w = await d.warmPage(p, base, login.cookie);
    warmed.push(`${p} ${w.status ?? "?"} ${Math.round((w.ms ?? 0) / 100) / 10}s`);
  }
  if (warmed.length) say(`Warmed: ${warmed.join(" · ")}`);

  return result(EXIT_READY.ready, `READY ${base} — ${restarted ? "restarted, " : ""}login ${args.role} ok, ${warmed.length} pages warm, ${secs()} s`);
}
