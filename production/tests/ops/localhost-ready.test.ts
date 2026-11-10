/**
 * R-2457 — `npm run localhost:ready` (scripts/ops/localhost-ready.mjs + localhost-ready-lib.mjs).
 * Pure helpers + the run with every side effect faked: never a real server, port, process or DB.
 * The hung-server path is proven here and with --dry-run only (4 Nov: the coordinator's :3001 is in use).
 */
import { describe, it, expect } from "vitest";
import {
  parseNetstatListeners, parseProcessList, isOurDevServerCmd, pickKillTarget, classifyServer,
  localGuardReason, updateNeedsRestart, parseReadyArgs, runReady, EXIT_READY, DEFAULT_WARM,
  pidFileTarget, parseTasklistImage, warmVerdict, loginHint,
  // @ts-expect-error — plain .mjs ops script, no types
} from "../../scripts/ops/localhost-ready-lib.mjs";

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1180
  TCP    0.0.0.0:3001           0.0.0.0:0              LISTENING       9001
  TCP    127.0.0.1:30010        0.0.0.0:0              LISTENING       7777
  TCP    127.0.0.1:3001         127.0.0.1:50122        ESTABLISHED     9001
  TCP    [::]:3001              [::]:0                 LISTENING       9001
  TCP    [::1]:54322            [::]:0                 LISTENING       4242
`;

/* A real-shaped dev:local tree: npm → cmd → node dev-local.mjs → cmd /c npx next dev → node next → node start-server (listener). */
const PROCS = [
  { ProcessId: 100, ParentProcessId: 1, Name: "explorer.exe", CommandLine: "C:\\Windows\\explorer.exe" },
  { ProcessId: 200, ParentProcessId: 100, Name: "WindowsTerminal.exe", CommandLine: "wt.exe" },
  { ProcessId: 300, ParentProcessId: 200, Name: "node.exe", CommandLine: "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js\" run dev:local" },
  { ProcessId: 400, ParentProcessId: 300, Name: "cmd.exe", CommandLine: "C:\\WINDOWS\\system32\\cmd.exe /d /s /c node scripts/dev-local.mjs" },
  { ProcessId: 500, ParentProcessId: 400, Name: "node.exe", CommandLine: "node  scripts/dev-local.mjs" },
  { ProcessId: 600, ParentProcessId: 500, Name: "cmd.exe", CommandLine: "C:\\WINDOWS\\system32\\cmd.exe /d /s /c \"npx next dev -p 3001 --turbopack\"" },
  { ProcessId: 700, ParentProcessId: 600, Name: "node.exe", CommandLine: "\"C:\\Program Files\\nodejs\\node.exe\" C:\\Users\\x\\reselleros-deploy\\production\\node_modules\\.bin\\..\\next\\dist\\bin\\next dev -p 3001 --turbopack" },
  { ProcessId: 9001, ParentProcessId: 700, Name: "node.exe", CommandLine: "\"C:\\Program Files\\nodejs\\node.exe\" C:\\Users\\x\\reselleros-deploy\\production\\node_modules\\next\\dist\\server\\lib\\start-server.js" },
  { ProcessId: 4242, ParentProcessId: 1, Name: "com.docker.backend.exe", CommandLine: "docker" },
];

describe("parseNetstatListeners", () => {
  it("returns the LISTENING pids on exactly that port (not 30010, not ESTABLISHED)", () => {
    expect(parseNetstatListeners(NETSTAT, 3001)).toEqual([9001]);
    expect(parseNetstatListeners(NETSTAT, 54322)).toEqual([4242]);
    expect(parseNetstatListeners(NETSTAT, 3005)).toEqual([]);
    expect(parseNetstatListeners("", 3001)).toEqual([]);
  });
});

describe("parseProcessList", () => {
  it("reads PowerShell ConvertTo-Json output (array or a single object)", () => {
    const m = parseProcessList(JSON.stringify(PROCS));
    expect(m.get(9001)).toMatchObject({ pid: 9001, ppid: 700, name: "node.exe" });
    const one = parseProcessList(JSON.stringify(PROCS[4]));
    expect([...one.keys()]).toEqual([500]);
    expect(parseProcessList("not json").size).toBe(0);
  });
});

describe("isOurDevServerCmd", () => {
  it("knows next dev / dev-local / next start-server", () => {
    for (const p of PROCS.filter((x) => [300, 400, 500, 600, 700, 9001].includes(x.ProcessId))) {
      expect(isOurDevServerCmd(p.CommandLine), p.CommandLine).toBe(true);
    }
  });
  it("does not match other node / system processes", () => {
    expect(isOurDevServerCmd("node C:\\tools\\some-server.js --port 3001")).toBe(false);
    expect(isOurDevServerCmd("C:\\Windows\\explorer.exe")).toBe(false);
    expect(isOurDevServerCmd("node node_modules/vitest/vitest.mjs run")).toBe(false);
    expect(isOurDevServerCmd("next build")).toBe(false);
    expect(isOurDevServerCmd("")).toBe(false);
  });
});

describe("pickKillTarget", () => {
  const procs = parseProcessList(JSON.stringify(PROCS));
  it("walks up to the topmost dev-server process (npm run dev:local), never the terminal", () => {
    const t = pickKillTarget({ listenerPid: 9001, procs, selfPid: 12345 });
    expect(t.ok).toBe(true);
    expect(t.pid).toBe(300);
    expect(t.chain).toEqual([9001, 700, 600, 500, 400, 300]);
  });
  it("review: with productionDir, refuses a next dev from another checkout (a worker's dev:local)", () => {
    expect(pickKillTarget({ listenerPid: 9001, procs, selfPid: 1, productionDir: "C:/Users/x/reselleros-deploy/production" }).ok).toBe(true);
    const t = pickKillTarget({ listenerPid: 9001, procs, selfPid: 1, productionDir: "C:/Users/x/reselleros-w-r-1/production" });
    expect(t.ok).toBe(false);
    expect(t.reason).toMatch(/not from/);
  });
  it("refuses a listener that is not our next dev server", () => {
    const other = parseProcessList(JSON.stringify([
      { ProcessId: 50, ParentProcessId: 1, Name: "node.exe", CommandLine: "node C:\\tools\\other-app.js" },
    ]));
    const t = pickKillTarget({ listenerPid: 50, procs: other, selfPid: 1 });
    expect(t.ok).toBe(false);
    expect(t.reason).toMatch(/not our/i);
  });
  it("refuses a non-node listener even with a next-looking command line", () => {
    const other = parseProcessList(JSON.stringify([
      { ProcessId: 51, ParentProcessId: 1, Name: "python.exe", CommandLine: "python next dev" },
    ]));
    expect(pickKillTarget({ listenerPid: 51, procs: other, selfPid: 1 }).ok).toBe(false);
  });
  it("refuses an unknown pid and never picks this script or its parents", () => {
    expect(pickKillTarget({ listenerPid: 999, procs, selfPid: 1 }).ok).toBe(false);
    // localhost:ready itself started from the same npm process tree → stop below it
    const t = pickKillTarget({ listenerPid: 9001, procs, selfPid: 12345, selfAncestors: [300, 200] });
    expect(t.ok).toBe(true);
    expect(t.pid).toBe(400);
    expect(pickKillTarget({ listenerPid: 9001, procs, selfPid: 9001 }).ok).toBe(false);
  });
});

describe("pidFileTarget + parseTasklistImage (process list unreadable — 4 Nov PowerShell/WMI hang)", () => {
  const rec = { pid: 500, port: 3001, dir: "C:\\Users\\x\\reselleros-deploy\\production", listenerPids: [9001] };
  it("reads tasklist CSV", () => {
    expect(parseTasklistImage('"node.exe","500","Console","1","120,000 K"')).toBe("node.exe");
    expect(parseTasklistImage("INFO: No tasks are running which match the specified criteria.")).toBeNull();
  });
  it("trusts only our own pid file: same port, same checkout, still node", () => {
    expect(pidFileTarget({ record: rec, port: 3001, image: "node.exe", productionDir: "c:/users/x/reselleros-deploy/production", listeners: [9001] }))
      .toEqual({ ok: true, pid: 500, chain: [500], via: "pidfile" });
    expect(pidFileTarget({ record: null, port: 3001, image: null }).ok).toBe(false);
    expect(pidFileTarget({ record: rec, port: 3005, image: "node.exe" }).ok).toBe(false);
    expect(pidFileTarget({ record: rec, port: 3001, image: "node.exe", productionDir: "C:/other/production" }).ok).toBe(false);
    expect(pidFileTarget({ record: rec, port: 3001, image: "chrome.exe" }).ok).toBe(false);
    expect(pidFileTarget({ record: rec, port: 3001, image: null }).ok).toBe(false);
    expect(pidFileTarget({ record: { ...rec, pid: 4 }, port: 3001, image: "node.exe", listeners: [9001] }).ok).toBe(false);
  });
  it("review: a recycled pid that is node again is refused unless the port's listener is the one it recorded", () => {
    expect(pidFileTarget({ record: rec, port: 3001, image: "node.exe", listeners: [7777] }).ok).toBe(false);
    expect(pidFileTarget({ record: { ...rec, listenerPids: [] }, port: 3001, image: "node.exe", listeners: [9001] }).ok).toBe(false);
    expect(pidFileTarget({ record: rec, port: 3001, image: "node.exe", listeners: [9001] }).ok).toBe(true);
  });
});

describe("classifyServer", () => {
  it("down when nothing listens", () => {
    expect(classifyServer({ listening: false, probes: [] })).toBe("down");
  });
  it("up when any probe got a non-5xx answer", () => {
    expect(classifyServer({ listening: true, probes: [{ ok: false, error: "timeout" }, { ok: true, status: 200 }] })).toBe("up");
  });
  it("hung when it LISTENS but every probe timed out / errored (4 Nov morning)", () => {
    expect(classifyServer({ listening: true, probes: [{ ok: false, error: "timeout" }, { ok: false, error: "timeout" }, { ok: false, error: "ECONNRESET" }] })).toBe("hung");
  });
  it("broken when it answers only 5xx (Build Error — a restart does not fix it)", () => {
    expect(classifyServer({ listening: true, probes: [{ ok: false, status: 500 }] })).toBe("broken");
  });
});

describe("localGuardReason", () => {
  const local = { url: "http://127.0.0.1:54321", dbUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" };
  it("passes the local stack", () => {
    expect(localGuardReason({ env: {}, status: local, container: "supabase_db_resellerosv3" })).toBeNull();
  });
  it("refuses a remote supabase status / env DB URL / production NODE_ENV / no container", () => {
    expect(localGuardReason({ env: {}, status: { ...local, url: "https://abc.supabase.co" }, container: "supabase_db_x" })).toMatch(/not local/);
    expect(localGuardReason({ env: { DATABASE_URL: "postgresql://u:p@10.1.2.3:5432/db" }, status: local, container: "supabase_db_x" })).toMatch(/not local/);
    expect(localGuardReason({ env: { NODE_ENV: "production" }, status: local, container: "supabase_db_x" })).toMatch(/production/);
    expect(localGuardReason({ env: {}, status: local, container: null })).toMatch(/supabase_db_/);
    expect(localGuardReason({ env: {}, status: null, container: "supabase_db_x" })).toMatch(/supabase status/);
  });
});

describe("warmVerdict / loginHint (review)", () => {
  it("5xx, no answer and a bounce to /login are broken; 200 and other redirects are fine", () => {
    expect(warmVerdict({ status: 500, ms: 1 })).toMatch(/500/);
    expect(warmVerdict({ status: "timeout", ms: 1 })).toMatch(/no answer/);
    expect(warmVerdict({ status: 307, location: "/login?next=%2Fquotes" })).toMatch(/login/);
    expect(warmVerdict({ status: 200 })).toBeNull();
    expect(warmVerdict({ status: 307, location: "/dashboard" })).toBeNull();
  });
  it("gives the fix that matches the status", () => {
    expect(loginHint(404)).toMatch(/dev:local/);
    expect(loginHint(400)).toMatch(/owner2/);
    expect(loginHint(400)).toMatch(/billing or support/);
    expect(loginHint(412)).toMatch(/seed-e2e-tenant/);
  });
});

describe("updateNeedsRestart / parseReadyArgs", () => {
  it("spots localhost:update's restart hint", () => {
    expect(updateNeedsRestart(["! production/next.config.ts badla — ye dev server restart par hi lagta hai. Restart coordinator ka faisla"])).toBe(true);
    expect(updateNeedsRestart(["Code: a → b", "  Koi migration lagani nahi thi."])).toBe(false);
  });
  it("parses flags and refuses unknown ones", () => {
    expect(parseReadyArgs([])).toMatchObject({ dryRun: false, port: 3001, restart: true, update: true, warm: DEFAULT_WARM });
    expect(parseReadyArgs(["--dry-run", "--port", "3005", "--no-restart", "--no-update", "--warm", "/a,/b"]))
      .toMatchObject({ dryRun: true, port: 3005, restart: false, update: false, warm: ["/a", "/b"] });
    expect(() => parseReadyArgs(["--kill-all"])).toThrow(/Unknown/);
    expect(parseReadyArgs(["--role", "Owner2"]).role).toBe("owner2");
    expect(parseReadyArgs(["--role", "billing"]).role).toBe("billing");
    expect(() => parseReadyArgs(["--role", "admin"])).toThrow(/role/);
    expect(() => parseReadyArgs(["--warm", "http://evil.example/x"])).toThrow(/path/);
  });
});

/* ───────── the run, all fakes ───────── */

function fakeDeps(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  let clock = 0;
  const deps = {
    calls,
    print: () => {},
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
    selfPid: 12345,
    selfAncestors: [],
    guard: () => null,
    dbContainer: () => "supabase_db_resellerosv3",
    startDb: () => { calls.push("startDb"); return true; },
    update: () => { calls.push("update"); return { code: 0, lines: ["Code: a → b", "  Koi migration lagani nahi thi."] }; },
    listeners: () => [9001],
    processes: () => parseProcessList(JSON.stringify(PROCS)),
    probe: async () => ({ ok: true, status: 200, ms: 40 }),
    kill: (pid: number) => { calls.push(`kill ${pid}`); return true; },
    start: () => { calls.push("start"); return { pid: 77, log: "C:/tmp/localhost-3001.log" }; },
    testLogin: async () => { calls.push("login"); return { ok: true, status: 200, cookie: "sb=1" }; },
    warmPage: async (p: string) => { calls.push(`warm ${p}`); return { status: 200, ms: 100 }; },
    ...over,
  };
  return deps;
}

describe("runReady", () => {
  it("healthy server: update → probe → login → warm → READY; no kill, no start", async () => {
    const d = fakeDeps();
    const r = await runReady({ ...d, args: parseReadyArgs(["--warm", "/dashboard,/quotes"]) });
    expect(r.code).toBe(EXIT_READY.ready);
    expect(r.state).toBe("up");
    expect(d.calls).toEqual(["update", "login", "warm /dashboard", "warm /quotes"]);
    expect(r.readyLine).toMatch(/^READY http:\/\/localhost:3001/);
    // 4 Nov: Google sign-in is off on localhost — the other-company path is printed
    expect(r.lines.join("\n")).toMatch(/local-login-link\.mjs <its owner>@example\.test/);
  });

  it("healthy server, --dry-run: no update writes, no login (a sign-in writes a session), no warm", async () => {
    const d = fakeDeps();
    const r = await runReady({ ...d, args: parseReadyArgs(["--dry-run"]) });
    expect(r.code).toBe(EXIT_READY.ready);
    expect(d.calls).toEqual(["update"]);
    expect(r.readyLine).toMatch(/^READY \[dry-run\]/);
  });

  it("refuses (nothing done) when the guard says not local", async () => {
    const d = fakeDeps({ guard: () => "database host \"db.prod\" is not local" });
    const r = await runReady({ ...d, args: parseReadyArgs([]) });
    expect(r.code).toBe(EXIT_READY.refused);
    expect(d.calls).toEqual([]);
    expect(r.readyLine).toMatch(/^NOT READY/);
  });

  it("hung server, --dry-run: names the process it WOULD kill, kills and starts nothing", async () => {
    const d = fakeDeps({ probe: async () => ({ ok: false, error: "timeout" }) });
    const r = await runReady({ ...d, args: parseReadyArgs(["--dry-run"]) });
    expect(r.state).toBe("hung");
    expect(d.calls.filter((c) => c.startsWith("kill") || c === "start")).toEqual([]);
    expect(r.lines.join("\n")).toMatch(/\[dry-run\].*300/);
    expect(r.code).toBe(EXIT_READY.notReady);
  });

  it("hung server: kills the dev-server tree root, starts dev:local, waits until it answers", async () => {
    let n = 0;
    const d = fakeDeps({
      // 3 hung probes, then the port frees, then the new server answers on its 2nd probe
      probe: async () => (++n <= 3 || n === 4 ? { ok: false, error: "timeout" } : { ok: true, status: 200, ms: 900 }),
      listeners: () => (d.calls.includes("kill 300") && !d.calls.includes("start") ? [] : [9001]),
    });
    const r = await runReady({ ...d, args: parseReadyArgs([]) });
    expect(d.calls.slice(0, 3)).toEqual(["update", "kill 300", "start"]);
    expect(r.code).toBe(EXIT_READY.ready);
    expect(r.restarted).toBe(true);
  });

  it("hung server owned by something else: refuses to kill", async () => {
    const d = fakeDeps({
      probe: async () => ({ ok: false, error: "timeout" }),
      processes: () => parseProcessList(JSON.stringify([{ ProcessId: 9001, ParentProcessId: 1, Name: "node.exe", CommandLine: "node other.js" }])),
    });
    const r = await runReady({ ...d, args: parseReadyArgs([]) });
    expect(d.calls.some((c) => c.startsWith("kill"))).toBe(false);
    expect(r.code).toBe(EXIT_READY.notReady);
    expect(r.lines.join("\n")).toMatch(/not our/i);
  });

  it("hung + process list unreadable: kills the pid-file server only", async () => {
    let n = 0;
    const d = fakeDeps({
      probe: async () => (++n <= 3 ? { ok: false, error: "timeout" } : { ok: true, status: 200, ms: 900 }),
      processes: () => new Map(),
      pidFileTarget: () => ({ ok: true, pid: 4321, chain: [4321], via: "pidfile" }),
      listeners: () => (d.calls.includes("kill 4321") && !d.calls.includes("start") ? [] : [9001]),
    });
    const r = await runReady({ ...d, args: parseReadyArgs([]) });
    expect(d.calls.slice(0, 3)).toEqual(["update", "kill 4321", "start"]);
    expect(r.code).toBe(EXIT_READY.ready);
  });

  it("hung + process list unreadable + no pid file: refuses, kills nothing", async () => {
    const d = fakeDeps({
      probe: async () => ({ ok: false, error: "timeout" }),
      processes: () => new Map(),
      pidFileTarget: () => ({ ok: false, reason: "process list unreadable and no localhost:ready pid file — not killing" }),
    });
    const r = await runReady({ ...d, args: parseReadyArgs([]) });
    expect(d.calls.some((c) => c.startsWith("kill"))).toBe(false);
    expect(r.code).toBe(EXIT_READY.notReady);
    expect(r.readyLine).toMatch(/by hand|not killing/);
  });

  it("hung with --no-restart: reports, does not kill", async () => {
    const d = fakeDeps({ probe: async () => ({ ok: false, error: "timeout" }) });
    const r = await runReady({ ...d, args: parseReadyArgs(["--no-restart"]) });
    expect(d.calls.some((c) => c.startsWith("kill"))).toBe(false);
    expect(r.code).toBe(EXIT_READY.notReady);
  });

  it("down (cold laptop): starts the DB if needed, starts dev:local, READY", async () => {
    let started = false;
    let db = false;
    const d = fakeDeps({
      dbContainer: () => (db ? "supabase_db_resellerosv3" : null),
      startDb: () => { d.calls.push("startDb"); db = true; return true; },
      listeners: () => (started ? [9001] : []),
      start: () => { d.calls.push("start"); started = true; return { pid: 77, log: "x.log" }; },
    });
    const r = await runReady({ ...d, args: parseReadyArgs([]) });
    expect(d.calls.slice(0, 3)).toEqual(["startDb", "update", "start"]);
    expect(r.code).toBe(EXIT_READY.ready);
  });

  it("broken (5xx): no kill, NOT READY with the reason", async () => {
    const d = fakeDeps({ probe: async () => ({ ok: false, status: 500 }) });
    const r = await runReady({ ...d, args: parseReadyArgs([]) });
    expect(d.calls.some((c) => c.startsWith("kill"))).toBe(false);
    expect(r.code).toBe(EXIT_READY.notReady);
    expect(r.readyLine).toMatch(/5xx|Build Error/);
  });

  it("test login failing is NOT READY with the seed hint (Chrome would not sign in)", async () => {
    const d = fakeDeps({ testLogin: async () => ({ ok: false, status: 412, error: "E2E_OWNER_PASSWORD is not set (.env.test)" }) });
    const r = await runReady({ ...d, args: parseReadyArgs([]) });
    expect(r.code).toBe(EXIT_READY.notReady);
    expect(r.lines.join("\n")).toMatch(/seed-e2e-tenant/);
  });

  it("update that needs a restart restarts our server (code a running server cannot pick up)", async () => {
    let killed = false;
    const d = fakeDeps({
      update: () => { d.calls.push("update"); return { code: 0, lines: ["! production/scripts/dev-local.mjs badla — ye dev server restart par hi lagta hai."] }; },
      kill: (pid: number) => { d.calls.push(`kill ${pid}`); killed = true; return true; },
      listeners: () => (killed && !d.calls.includes("start") ? [] : [9001]),
    });
    const r = await runReady({ ...d, args: parseReadyArgs([]) });
    expect(d.calls).toContain("kill 300");
    expect(r.restarted).toBe(true);
    expect(r.code).toBe(EXIT_READY.ready);
  });

  it("review: localhost:update exit 4 (DB not reachable, migrations not checked) is NOT READY", async () => {
    const d = fakeDeps({ update: () => { d.calls.push("update"); return { code: 4, lines: ["! Local DB nahi mila"] }; } });
    const r = await runReady({ ...d, args: parseReadyArgs([]) });
    expect(r.code).toBe(EXIT_READY.notReady);
    expect(d.calls).toEqual(["update"]);
  });

  it("review: two listeners in one tree → one kill, READY", async () => {
    let n = 0;
    const d = fakeDeps({
      probe: async () => (++n <= 3 ? { ok: false, error: "timeout" } : { ok: true, status: 200, ms: 900 }),
      listeners: () => (d.calls.includes("kill 300") && !d.calls.includes("start") ? [] : [9001, 700]),
    });
    const r = await runReady({ ...d, args: parseReadyArgs([]) });
    expect(d.calls.filter((c) => c.startsWith("kill"))).toEqual(["kill 300"]);
    expect(r.code).toBe(EXIT_READY.ready);
  });

  it("review: dev:local that exits at once is reported straight away, not after 5 min", async () => {
    const d = fakeDeps({
      listeners: () => [],
      start: () => { d.calls.push("start"); return { pid: 77, log: "x.log", exited: () => 2 }; },
      probe: async () => ({ ok: false, error: "ECONNREFUSED" }),
    });
    const r = await runReady({ ...d, args: parseReadyArgs([]) });
    expect(r.code).toBe(EXIT_READY.notReady);
    expect(r.readyLine).toMatch(/stopped by itself \(exit 2\)/);
  });

  it("review: the started server's listeners are recorded; a kill forgets the pid file", async () => {
    let n = 0;
    const rec: unknown[] = [];
    const d = fakeDeps({
      probe: async () => (++n <= 3 ? { ok: false, error: "timeout" } : { ok: true, status: 200, ms: 900 }),
      listeners: () => (d.calls.includes("kill 300") && !d.calls.includes("start") ? [] : [9001]),
      recordStarted: (port: number, l: number[]) => rec.push([port, l]),
      forgetStarted: () => d.calls.push("forget"),
    });
    await runReady({ ...d, args: parseReadyArgs([]) });
    expect(d.calls).toContain("forget");
    expect(rec).toEqual([[3001, [9001]]]);
  });

  it("review: a warmed page bounced to /login is NOT READY", async () => {
    const d = fakeDeps({ warmPage: async (p: string) => { d.calls.push(`warm ${p}`); return { status: 307, ms: 5, location: "/login" }; } });
    const r = await runReady({ ...d, args: parseReadyArgs(["--warm", "/quotes"]) });
    expect(r.code).toBe(EXIT_READY.notReady);
    expect(r.readyLine).toMatch(/\/quotes/);
  });

  it("review: --dry-run on a cold laptop says what it would do (no guard refusal)", async () => {
    const d = fakeDeps({ dbContainer: () => null, guard: () => "no local Supabase DB container" });
    const r = await runReady({ ...d, args: parseReadyArgs(["--dry-run"]) });
    expect(r.code).toBe(EXIT_READY.notReady);
    expect(r.readyLine).toMatch(/\[dry-run\].*supabase start/);
    expect(d.calls).toEqual([]);
  });

  it("a failed localhost:update (migration failed) is NOT READY and does not start anything", async () => {
    const d = fakeDeps({ update: () => { d.calls.push("update"); return { code: 3, lines: ["✗ 2026_x.sql FAIL"] }; } });
    const r = await runReady({ ...d, args: parseReadyArgs([]) });
    expect(r.code).toBe(EXIT_READY.notReady);
    expect(d.calls).toEqual(["update"]);
  });
});
