import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
// @ts-expect-error — plain .mjs ops script, no types
import { HOT_FILES, isHotFile, withoutHot, globToRegExp, hotBlockers, withHotFiles, readHotHolds, HOT_STALE_MS } from "../../scripts/ops/worker-lock-hot.mjs";
// @ts-expect-error — plain .mjs ops script, no types
import { findConflicts, LOCK_VERSION } from "../../scripts/ops/worker-lock.mjs";

/*
 * R-2826 (14 Nov 2026): hot shared files (renewals page.tsx, row-cells.tsx …) are taken only at push.
 * 14 Nov night four workers held renewals/page.tsx from the start and blocked a ready 4-line card for
 * an hour. claim / check never block on or record a hot file; push takes it with a FIFO wait.
 */
const R = "src/app/(app)/renewals";
const script = path.resolve("scripts/ops/worker-lock.mjs");
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("R-2826 the hot list", () => {
  it("names the six renewals files, and only those", () => {
    for (const f of ["page.tsx", "row-cells.tsx", "queue.ts", "tiles-card.tsx", "renewal-drawer.tsx", "last-docs-cell.tsx"]) expect(isHotFile(`${R}/${f}`)).toBe(true);
    expect(HOT_FILES).toHaveLength(6);
    expect(isHotFile(`${R}/queue-items.ts`)).toBe(false);
    expect(isHotFile(`${R}/classify.ts`)).toBe(false);
    expect(isHotFile("src/app/(app)/leads/page.tsx")).toBe(false);
  });

  it("accepts production/ and backslash forms", () => {
    expect(isHotFile(`production/${R}/page.tsx`)).toBe(true);
    expect(isHotFile(`${R.replace(/\//g, "\\")}\\page.tsx`)).toBe(true);
  });

  it("glob: * stays inside one folder, ** crosses folders, dots and parentheses are literal", () => {
    expect(globToRegExp("src/a/*.tsx").test("src/a/x.tsx")).toBe(true);
    expect(globToRegExp("src/a/*.tsx").test("src/a/b/x.tsx")).toBe(false);
    expect(globToRegExp("src/a/**/x.tsx").test("src/a/b/c/x.tsx")).toBe(true);
    expect(globToRegExp("src/a/**/x.tsx").test("src/a/x.tsx")).toBe(true);
    expect(globToRegExp("src/(app)/p.tsx").test("src/(app)/p.tsx")).toBe(true);
    expect(globToRegExp("src/p.tsx").test("src/pxtsx")).toBe(false);
    expect(isHotFile("src/z/y/page.tsx", ["src/z/**"])).toBe(true);
    expect(withoutHot([`${R}/page.tsx`, `${R}/drawer.ts`])).toEqual([`${R}/drawer.ts`]);
  });
});

describe("R-2826 conflicts ignore hot files, nothing else", () => {
  const lock = (card: string, areas: string[], files: string[] = []) => ({ card, lockVersion: LOCK_VERSION, areas, files, moves: [], worktree: `C:/wt/${card}` });

  it("claim on a hot file passes while another card holds it (claimed, recorded or live)", () => {
    const holder = lock("R-2818", [`${R}/page.tsx`, `${R}/drawer.ts`], [`${R}/renewal-drawer.tsx`]);
    expect(findConflicts("R-2817", [`${R}/page.tsx`, `${R}/renewal-drawer.tsx`], [holder])).toEqual([]);
    const live = () => [`${R}/row-cells.tsx`];
    expect(findConflicts("R-2817", [`${R}/row-cells.tsx`], [holder], { live })).toEqual([]);
  });

  it("an OLD lock (no lockVersion) that recorded a hot file stops blocking too", () => {
    const old = { card: "R-2751", areas: [R, `${R}/page.tsx`], files: [`${R}/queue.ts`], worktree: "C:/wt/R-2751" };
    expect(findConflicts("R-2817", [`${R}/page.tsx`, `${R}/queue.ts`], [old])).toEqual([]);
  });

  it("a non-hot overlap still blocks", () => {
    const holder = lock("R-2818", [`${R}/page.tsx`, `${R}/drawer.ts`]);
    const c = findConflicts("R-2817", [`${R}/page.tsx`, `${R}/drawer.ts`], [holder]);
    expect(c).toEqual([{ card: "R-2818", mine: `${R}/drawer.ts`, theirs: `${R}/drawer.ts` }]);
  });
});

describe("R-2826 hot blockers (pure)", () => {
  const f = [`${R}/page.tsx`];
  it("a hold on my file blocks; a hold on another file does not", () => {
    expect(hotBlockers("R-2", f, { holds: [{ card: "R-1", files: f }], waiters: [], readyAt: 5 })).toEqual(["R-1"]);
    expect(hotBlockers("R-2", f, { holds: [{ card: "R-1", files: [`${R}/queue.ts`] }], waiters: [], readyAt: 5 })).toEqual([]);
  });
  it("only a waiter that was ready EARLIER goes first (FIFO), ties by card id", () => {
    const w = (card: string, readyAt: number) => ({ card, files: f, readyAt });
    expect(hotBlockers("R-2", f, { holds: [], waiters: [w("R-1", 4), w("R-3", 9)], readyAt: 5 })).toEqual(["R-1"]);
    expect(hotBlockers("R-2", f, { holds: [], waiters: [w("R-1", 5), w("R-3", 5)], readyAt: 5 })).toEqual(["R-1"]);
  });
});

describe("R-2826 push takes hot files with a FIFO wait", () => {
  let dir: string;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "r2826-locks-")); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const opts = (readyAt: number, extra = {}) => ({ dir, readyAt, pollMs: 10, ...extra });
  const page = [`${R}/page.tsx`];

  it("two pushes on one hot file serialize; the one ready first goes first", async () => {
    const events: string[] = [];
    const run = (card: string, readyAt: number, files = page) => withHotFiles(card, files, async () => {
      events.push(`${card}:start`); await tick(80); events.push(`${card}:end`);
    }, opts(readyAt));
    const a = run("R-1", 1);
    await tick(30);
    expect(readHotHolds(dir).map((h: { card: string }) => h.card)).toEqual(["R-1"]);
    /* R-3 asks first in wall-clock but was ready LATER than R-2 */
    const c = run("R-3", 30);
    const b = run("R-2", 20);
    await Promise.all([a, b, c]);
    expect(events).toEqual(["R-1:start", "R-1:end", "R-2:start", "R-2:end", "R-3:start", "R-3:end"]);
    expect(fs.readdirSync(dir).filter((n) => n.startsWith("_hot"))).toEqual([]);
  });

  it("a push on a different hot file does not wait", async () => {
    const events: string[] = [];
    const a = withHotFiles("R-1", page, async () => { events.push("R-1:start"); await tick(100); events.push("R-1:end"); }, opts(1));
    await tick(20);
    await withHotFiles("R-2", [`${R}/queue.ts`], async () => { events.push("R-2:ran"); }, opts(2));
    await a;
    expect(events).toEqual(["R-1:start", "R-2:ran", "R-1:end"]);
  });

  it("the hold is freed when the push fails", async () => {
    await expect(withHotFiles("R-9", page, async () => { throw new Error("push failed"); }, opts(1))).rejects.toThrow("push failed");
    expect(readHotHolds(dir)).toEqual([]);
    /* and the next card is not held up */
    await withHotFiles("R-10", page, async () => {}, opts(2));
  });

  it("a stale hold (crashed push, no heartbeat) is freed and taken over", async () => {
    const stale = path.join(dir, "_hot-R-77.json");
    fs.writeFileSync(stale, JSON.stringify({ card: "R-77", files: page, readyAt: 1, at: Date.now() - HOT_STALE_MS - 60_000 }));
    let ran = false;
    await withHotFiles("R-78", page, async () => { ran = true; }, opts(5));
    expect(ran).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
  });

  it("a fresh hold is NOT taken over; the waiter gives up with HOT_TIMEOUT", async () => {
    const fresh = path.join(dir, "_hot-R-80.json");
    fs.writeFileSync(fresh, JSON.stringify({ card: "R-80", files: page, readyAt: 1, at: Date.now() }));
    await expect(withHotFiles("R-81", page, async () => {}, opts(5, { waitMs: 100 }))).rejects.toMatchObject({ code: "HOT_TIMEOUT" });
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(path.join(dir, "_hotwait-R-81.json"))).toBe(false);
    fs.rmSync(fresh);
  });

  it("no hot files → just runs, writes nothing", async () => {
    const before = fs.readdirSync(dir).length;
    expect(await withHotFiles("R-5", [], async () => 42, opts(1))).toBe(42);
    expect(fs.readdirSync(dir).length).toBe(before);
  });
});

describe("R-2826 claim and check through the real script", () => {
  let dir: string, cardDir: string, repoA: string, repoB: string;
  const cardFile = (id: string) => {
    const f = path.join(cardDir, `${id}.json`);
    fs.writeFileSync(f, JSON.stringify({ id, kind: "bug", category: "process", doneWhen: "x", triage: { verdict: "build", why: "y", at: "z" } }));
    return f;
  };
  const run = (args: string[], cwd = path.resolve(".")) => spawnSync(process.execPath, [script, ...args], { cwd, env: { ...process.env, WORKER_LOCK_DIR: dir, WORKER_MAX: "4" }, encoding: "utf8" });
  const claim = (card: string, wt: string, ...paths: string[]) => run(["claim", card, wt, ...paths, "--card", cardFile(card)]);
  const repo = (name: string) => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), `r2826-${name}-`));
    const g = (...a: string[]) => execFileSync("git", ["-C", r, ...a], { stdio: "ignore" });
    g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
    fs.mkdirSync(path.join(r, "production", ...R.split("/")), { recursive: true });
    for (const n of ["page.tsx", "drawer.ts"]) fs.writeFileSync(path.join(r, "production", ...R.split("/"), n), "export const a = 1;\n");
    g("add", "-A"); g("commit", "-qm", "base"); g("update-ref", "refs/remotes/anutech/manager-pardeep", "HEAD");
    return r;
  };
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r2826-claim-locks-"));
    cardDir = fs.mkdtempSync(path.join(os.tmpdir(), "r2826-cards-"));
    repoA = repo("a"); repoB = repo("b");
  });
  afterAll(() => { for (const d of [dir, cardDir, repoA, repoB]) fs.rmSync(d, { recursive: true, force: true }); });

  it("claim: a hot file is skipped (one line), never recorded, and a second card takes the same hot file at once", () => {
    const a = claim("R-1", repoA, `${R}/page.tsx`, `${R}/drawer.ts`);
    expect(a.status).toBe(0);
    expect(a.stdout).toContain(`hot file — taken at push: ${R}/page.tsx`);
    const lock = JSON.parse(fs.readFileSync(path.join(dir, "R-1.json"), "utf8"));
    expect(lock.areas).toEqual([`${R}/drawer.ts`]);
    const b = claim("R-2", repoB, `${R}/page.tsx`);
    expect(b.status).toBe(0);
    expect(b.stdout).toContain("hot file — taken at push");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "R-2.json"), "utf8")).areas).toEqual([]);
  });

  it("claim: a non-hot overlap still blocks (exit 2)", () => {
    const c = claim("R-3", repoB, `${R}/page.tsx`, `${R}/drawer.ts`);
    expect(c.status).toBe(2);
    expect(c.stderr).toContain("R-1");
  });

  it("check: a changed hot file prints the line, is not a conflict and is not recorded", () => {
    /* R-1's worktree really changes page.tsx AND drawer.ts; R-2's worktree changes page.tsx too */
    fs.writeFileSync(path.join(repoA, "production", ...R.split("/"), "page.tsx"), "export const a = 2;\n");
    fs.writeFileSync(path.join(repoB, "production", ...R.split("/"), "page.tsx"), "export const a = 3;\n");
    const r = run(["check", "R-2", "--card", cardFile("R-2")], path.join(repoB, "production"));
    expect(r.stdout + r.stderr).toContain(`hot file — taken at push: ${R}/page.tsx`);
    expect(r.status).toBe(0);
    const lock = JSON.parse(fs.readFileSync(path.join(dir, "R-2.json"), "utf8"));
    expect(lock.files).toEqual([]);
  });

  it("check: the same non-hot file changed in both worktrees is still refused", () => {
    fs.writeFileSync(path.join(repoA, "production", ...R.split("/"), "drawer.ts"), "export const a = 2;\n");
    fs.writeFileSync(path.join(repoB, "production", ...R.split("/"), "drawer.ts"), "export const a = 3;\n");
    const r = run(["check", "R-2", "--card", cardFile("R-2")], path.join(repoB, "production"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("R-1");
  });
});
