import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
// @ts-expect-error — plain .mjs ops script, no types
import { countsTowardCap, queueFull, claimSlot, lockAfterPush, lockAfterCi, lockWorking, updateLock, LOCK_STATES, CI_EXIT } from "../scripts/ops/worker-lock.mjs";

/*
 * R-1973 (26 Oct 2026): R-1920's claim was refused with exit 3 (2 workers by day) while R-1961 had
 * already pushed and was only waiting 20–25 min in `worker-lock ci`. A card waiting on CI no longer
 * fills a slot, but keeps its files until CI is green or red; on red the same card takes a slot back
 * with --fixes-red.
 */
const root = path.resolve(__dirname, "..");
const script = path.join(root, "scripts", "ops", "worker-lock.mjs");

type Lock = { card: string; worktree?: string; areas: string[]; files?: string[]; state?: string };
const lk = (card: string, areas: string[], state?: string): Lock => ({ card, areas, files: [], ...(state ? { state } : {}) });

describe("R-1973: cap counting — a card waiting on CI does not use a slot", () => {
  it("working (and old locks without a state) count; ci-wait / ci-red do not", () => {
    expect(countsTowardCap(lk("R-1", ["a/b/c"]))).toBe(true);
    expect(countsTowardCap(lk("R-1", ["a/b/c"], "working"))).toBe(true);
    expect(countsTowardCap(lk("R-1", ["a/b/c"], LOCK_STATES.ciWait))).toBe(false);
    expect(countsTowardCap(lk("R-1", ["a/b/c"], LOCK_STATES.ciRed))).toBe(false);
  });

  it("the 26 Oct case: R-1961 in ci-wait + one working card → R-1920 may start (cap 2)", () => {
    const locks = [lk("R-1961", ["src/lib/x"], LOCK_STATES.ciWait), lk("R-1959", ["src/lib/y"])];
    expect(queueFull("R-1920", locks, 2)).toBe(false);
    expect(claimSlot("R-1920", locks, { max: 2 })).toEqual({ ok: true, overCap: false });
    /* two cards really building → still full */
    expect(queueFull("R-1920", [...locks, lk("R-1958", ["src/lib/z"])], 2)).toBe(true);
  });

  it("red → only the same card with --fixes-red takes a slot back over a full cap", () => {
    const locks = [lk("R-1", ["src/lib/a"]), lk("R-2", ["src/lib/b"]), lk("R-3", ["src/lib/c"], LOCK_STATES.ciRed)];
    expect(claimSlot("R-3", locks, { max: 2 })).toEqual({ ok: false, overCap: false });
    expect(claimSlot("R-3", locks, { max: 2, fixesRed: true })).toEqual({ ok: true, overCap: true });
    /* --fixes-red is no way past the cap for a card that holds no CI-waiting lock */
    expect(claimSlot("R-9", locks, { max: 2, fixesRed: true }).ok).toBe(false);
  });

  it("push → ci-wait; ci green → lock removed; red → ci-red; timeout → unchanged; re-claim → working", () => {
    const base = { ...lk("R-7", ["src/lib/q"]), worktree: "/w", claimedAt: "t0" };
    const waiting = lockAfterPush(base, { sha: "abc", at: "t1" });
    expect(waiting).toMatchObject({ state: "ci-wait", pushedSha: "abc", ciWaitSince: "t1", areas: ["src/lib/q"] });
    expect(lockAfterCi(waiting, CI_EXIT.green, { at: "t2" })).toBeNull();
    const red = lockAfterCi(waiting, CI_EXIT.red, { at: "t2" });
    expect(red).toMatchObject({ state: "ci-red", ciRedAt: "t2", areas: ["src/lib/q"] });
    expect(lockAfterCi(waiting, CI_EXIT.timeout, { at: "t2" })).toEqual(waiting);
    const back = lockWorking(red);
    expect(back.state).toBe("working");
    expect(back).not.toHaveProperty("ciRedAt");
    expect(back.areas).toEqual(["src/lib/q"]);
  });
});

/* ── fake lock folder + the real CLI (claim / list), WORKER_MAX=2 ── */
describe("R-1973: claim on a real lock folder", () => {
  let dir: string;
  let wt: string;
  let cardDir: string;
  const env = () => ({ ...process.env, WORKER_LOCK_DIR: dir, WORKER_MAX: "2" });
  const cardFile = (id: string) => {
    const f = path.join(cardDir, `${id}.json`);
    fs.writeFileSync(f, JSON.stringify({ id, kind: "bug", category: "process", doneWhen: "x", triage: { verdict: "build", why: "y", at: "z" } }));
    return f;
  };
  const writeLock = (l: Lock) => fs.writeFileSync(path.join(dir, `${l.card}.json`), JSON.stringify({ worktree: wt, claimedAt: "2026-10-26T00:00:00Z", ...l }));
  const readLock = (card: string) => JSON.parse(fs.readFileSync(path.join(dir, `${card}.json`), "utf8"));
  const cli = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: root, env: env(), encoding: "utf8" });
  const claim = (card: string, ...rest: string[]) => cli("claim", card, ...rest, "--card", cardFile(card));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r1973-locks-"));
    wt = fs.mkdtempSync(path.join(os.tmpdir(), "r1973-wt-"));
    cardDir = fs.mkdtempSync(path.join(os.tmpdir(), "r1973-cards-"));
  });
  afterEach(() => { for (const d of [dir, wt, cardDir]) fs.rmSync(d, { recursive: true, force: true }); });

  it("a new claim is allowed while another card waits on CI (was exit 3)", () => {
    writeLock(lk("R-1961", ["src/lib/ci-card"], LOCK_STATES.ciWait));
    writeLock(lk("R-1959", ["src/lib/busy"]));
    const r = claim("R-1920", wt, "src/lib/new-card");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(readLock("R-1920").state).toBe("working");
    /* now two cards build → the next one is refused, and the message says ci-wait does not count */
    const next = claim("R-1921", wt, "src/lib/other");
    expect(next.status).toBe(3);
    expect(next.stderr).toContain("R-1961 ci-wait");
    expect(cli("list", "R-1").stdout).toMatch(/R-1961\s+ci-wait \(slot nahi ginta\)/);
  });

  it("an old lock with no state still counts (cap unchanged for locks made before R-1973)", () => {
    writeLock(lk("R-1", ["src/lib/one"]));
    writeLock(lk("R-2", ["src/lib/two"]));
    expect(claim("R-3", wt, "src/lib/three").status).toBe(3);
  });

  it("a file clash with a ci-wait card is still refused (exit 2)", () => {
    writeLock({ ...lk("R-1961", ["src/lib/ci-card"], LOCK_STATES.ciWait), files: ["src/app/(app)/x/page.tsx"] });
    const r = claim("R-1920", wt, "src/lib/ci-card/sub");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("R-1961");
    const r2 = claim("R-1920", wt, "src/app/(app)/x");
    expect(r2.status).toBe(2);
  });

  it("red → the same card takes its slot back with --fixes-red, over a full cap; files kept", () => {
    writeLock(lk("R-1", ["src/lib/one"]));
    writeLock(lk("R-2", ["src/lib/two"]));
    writeLock({ ...lk("R-3", ["src/lib/three"], LOCK_STATES.ciRed), files: ["src/lib/three/a.ts"] });
    const without = claim("R-3", wt, "src/lib/three");
    expect(without.status).toBe(3);
    const back = claim("R-3", "--fixes-red");
    expect(back.stderr).toBe("");
    expect(back.status).toBe(0);
    const l = readLock("R-3");
    expect(l.state).toBe("working");
    expect(l.areas).toEqual(["src/lib/three"]);
    expect(l.files).toEqual(["src/lib/three/a.ts"]);
    /* while R-3 waited on red, its files were still its own */
    writeLock(lk("R-3", ["src/lib/three"], LOCK_STATES.ciRed));
    expect(claim("R-4", wt, "src/lib/three").status).not.toBe(0);
  });

  it("--fixes-red does not let a card with no CI-waiting lock past the cap", () => {
    writeLock(lk("R-1", ["src/lib/one"]));
    writeLock(lk("R-2", ["src/lib/two"]));
    expect(claim("R-9", wt, "src/lib/nine", "--fixes-red").status).toBe(3);
    expect(claim("R-9", "--fixes-red").status).toBe(1); // no lock to take back, no paths
  });

  it("updateLock: push → ci-wait, then ci green removes the lock (files free for the next card)", () => {
    writeLock(lk("R-5", ["src/lib/five"]));
    updateLock("R-5", (l: Lock) => lockAfterPush(l, { sha: "deadbeef", at: "t" }), dir);
    expect(readLock("R-5")).toMatchObject({ state: "ci-wait", pushedSha: "deadbeef" });
    expect(claim("R-6", wt, "src/lib/five").status).toBe(2);
    updateLock("R-5", (l: Lock) => lockAfterCi(l, CI_EXIT.green, { at: "t" }), dir);
    expect(fs.existsSync(path.join(dir, "R-5.json"))).toBe(false);
    expect(claim("R-6", wt, "src/lib/five").status).toBe(0);
    expect(updateLock("R-404", (l: Lock) => l, dir)).toEqual({ found: false });
  });
});

describe("R-1973: wiring in push / ci", () => {
  const src = fs.readFileSync(script, "utf8");
  it("push sets ci-wait only AFTER the real git push, and a new push takes the slot back first", () => {
    const push = src.slice(src.indexOf("async function pushWithTurn"), src.indexOf("R-1898 (25 Oct 2026)"));
    const gitPush = push.indexOf('sh("git push -q anutech HEAD:manager-pardeep"');
    expect(gitPush).toBeGreaterThan(0);
    expect(push.indexOf("lockAfterPush")).toBeGreaterThan(gitPush);
    expect(push.indexOf("lockWorking")).toBeGreaterThan(0);
    expect(push.indexOf("lockWorking")).toBeLessThan(push.indexOf('withTurn("push"'));
  });
  it("ci applies its verdict to the lock", () => {
    const ci = src.slice(src.indexOf('if (cmd === "ci")'), src.indexOf('if (cmd === "sql-related")'));
    expect(ci).toContain("lockAfterCi(l, r.code");
  });
});
