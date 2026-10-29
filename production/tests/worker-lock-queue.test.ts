import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
// @ts-expect-error — plain .mjs ops script, no types
import { queueOrder, queueTurn, liveQueue, lockActivityAt, isStaleLock, normPriority, parseQueueFlags, STALE_MS, STALE_CI_MS, QUEUE_STALE_MS } from "../scripts/ops/worker-lock.mjs";

/*
 * R-2105 (29 Oct 2026): a refused claim used to mean "retry every 5 min, give up after 30", in no order;
 * a stopped worker's lock blocked everyone until a human ran `release`. Now `claim --wait` queues by
 * priority (p0 > p1 > p2) then first come, and a lock with no sign of life for 60 min (ci-wait/ci-red 120)
 * is released by whoever reads the locks next, logged in `_stale-release.log`.
 */
const root = path.resolve(__dirname, "..");
const script = path.join(root, "scripts", "ops", "worker-lock.mjs");
const NOW = Date.parse("2026-10-29T12:00:00Z");

describe("R-2105 queue order", () => {
  const e = (card: string, priority: string, joinedAt: number, waitingFor = "slot") => ({ card, priority, joinedAt, seenAt: NOW, waitingFor });

  it("p0 before p1 before p2, then first come first served", () => {
    const order = queueOrder([e("R-3", "p2", 1), e("R-2", "p1", 5), e("R-1", "p1", 2), e("R-0", "p0", 9)]);
    expect(order.map((x: { card: string }) => x.card)).toEqual(["R-0", "R-1", "R-2", "R-3"]);
  });

  it("a card's turn comes when no slot-waiter is ahead; a file-waiter does not hold others up", () => {
    const q = [e("R-1", "p1", 1), e("R-2", "p1", 2), e("R-9", "p0", 3, "files")];
    expect(queueTurn("R-1", q, NOW)).toEqual({ turn: true, ahead: [] });
    expect(queueTurn("R-2", q, NOW)).toEqual({ turn: false, ahead: ["R-1"] });
    /* a claim that is not in the queue waits behind every slot-waiter */
    expect(queueTurn("R-5", q, NOW).ahead).toEqual(["R-1", "R-2"]);
  });

  it("a waiter that stopped refreshing drops out by itself", () => {
    const q = [{ ...e("R-1", "p0", 1), seenAt: NOW - QUEUE_STALE_MS - 1 }, e("R-2", "p2", 2)];
    expect(liveQueue(q, NOW).map((x: { card: string }) => x.card)).toEqual(["R-2"]);
    expect(queueTurn("R-2", q, NOW).turn).toBe(true);
  });

  it("priority comes from the flag, any case; junk is ignored", () => {
    expect(normPriority("P0")).toBe("p0");
    expect(normPriority("urgent")).toBe(null);
    expect(parseQueueFlags(["wt", "--wait", "--priority", "p0", "src/lib/a"])).toEqual({ rest: ["wt", "src/lib/a"], wait: true, priority: "p0", waitMin: 240 });
  });
});

describe("R-2105 stale locks", () => {
  it("activity is the newest of beat, claim, ci times and the mtimes the caller read", () => {
    expect(lockActivityAt({ claimedAt: "2026-10-29T10:00:00Z", beatAt: "2026-10-29T11:00:00Z" }, [])).toBe(Date.parse("2026-10-29T11:00:00Z"));
    expect(lockActivityAt({ claimedAt: "2026-10-29T10:00:00Z" }, [NOW - 1000])).toBe(NOW - 1000);
  });

  it("working: 60 min quiet → stale; ci-wait / ci-red get 120 min", () => {
    expect(isStaleLock({ state: "working" }, NOW, NOW - STALE_MS - 1)).toBe(true);
    expect(isStaleLock({}, NOW, NOW - STALE_MS + 60_000)).toBe(false);
    expect(isStaleLock({ state: "ci-wait" }, NOW, NOW - STALE_MS - 1)).toBe(false);
    expect(isStaleLock({ state: "ci-red" }, NOW, NOW - STALE_CI_MS - 1)).toBe(true);
  });
});

/* ── a fake lock folder + the real CLI ── */
describe("R-2105 on a real lock folder", () => {
  let dir: string, wt: string, cardDir: string;
  const env = (extra: Record<string, string> = {}) => ({ ...process.env, WORKER_LOCK_DIR: dir, WORKER_MAX: "1", WORKER_QUEUE_POLL_MS: "300", ...extra });
  const cardFile = (id: string, priority?: string) => {
    const f = path.join(cardDir, `${id}.json`);
    fs.writeFileSync(f, JSON.stringify({ id, kind: "bug", category: "process", doneWhen: "x", triage: { verdict: "build", why: "y", at: "z" }, ...(priority ? { priority } : {}) }));
    return f;
  };
  const lockPath = (card: string) => path.join(dir, `${card}.json`);
  const writeLock = (l: Record<string, unknown>, ageMs = 0) => {
    fs.writeFileSync(lockPath(l.card as string), JSON.stringify({ worktree: wt, claimedAt: new Date(Date.now() - ageMs).toISOString(), areas: [], files: [], ...l }));
    if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(lockPath(l.card as string), t, t); }
  };
  const cli = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: root, env: env(), encoding: "utf8" });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r2105-locks-"));
    wt = fs.mkdtempSync(path.join(os.tmpdir(), "r2105-wt-"));
    cardDir = fs.mkdtempSync(path.join(os.tmpdir(), "r2105-cards-"));
  });
  afterEach(() => { for (const d of [dir, wt, cardDir]) fs.rmSync(d, { recursive: true, force: true }); });

  it("a working lock quiet for 61 min is released by the next reader and logged; a fresh one stays", () => {
    writeLock({ card: "R-1", areas: ["src/lib/one"] }, 61 * 60_000);
    writeLock({ card: "R-2", areas: ["src/lib/two"], state: "ci-wait" }, 61 * 60_000);
    const r = cli("list", "R-0");
    expect(r.stdout).toContain("R-1 ka lock hata");
    expect(fs.existsSync(lockPath("R-1"))).toBe(false);
    expect(fs.existsSync(lockPath("R-2"))).toBe(true);
    const log = fs.readFileSync(path.join(dir, "_stale-release.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log).toEqual([expect.objectContaining({ card: "R-1", state: "working" })]);
  });

  it("beat keeps a lock alive", () => {
    writeLock({ card: "R-1", areas: ["src/lib/one"] }, 50 * 60_000);
    expect(cli("beat", "R-1").status).toBe(0);
    const l = JSON.parse(fs.readFileSync(lockPath("R-1"), "utf8"));
    expect(Date.now() - Date.parse(l.beatAt)).toBeLessThan(60_000);
  });

  it("a plain claim does not jump a waiting queue; it says to use --wait", () => {
    fs.writeFileSync(path.join(dir, "_queue-R-7.json"), JSON.stringify({ card: "R-7", priority: "p0", joinedAt: Date.now(), seenAt: Date.now(), waitingFor: "slot" }));
    const r = cli("claim", "R-8", wt, "src/lib/eight", "--card", cardFile("R-8"));
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("R-7");
    expect(r.stderr).toContain("--wait");
  });

  it("claim --wait blocks while the slot is taken, then takes it with the card's priority; queue file gone", async () => {
    writeLock({ card: "R-1", areas: ["src/lib/one"] });
    const child = spawn(process.execPath, [script, "claim", "R-2", wt, "src/lib/two", "--wait", "--card", cardFile("R-2", "p1")], { cwd: root, env: env() });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    await new Promise((r) => setTimeout(r, 2500));
    expect(fs.existsSync(path.join(dir, "_queue-R-2.json"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "_queue-R-2.json"), "utf8")).priority).toBe("p1");
    fs.rmSync(lockPath("R-1"));
    const code = await new Promise((r) => child.on("exit", r));
    expect(code, out).toBe(0);
    expect(JSON.parse(fs.readFileSync(lockPath("R-2"), "utf8"))).toMatchObject({ state: "working", priority: "p1" });
    expect(fs.existsSync(path.join(dir, "_queue-R-2.json"))).toBe(false);
  }, 20_000);
});
