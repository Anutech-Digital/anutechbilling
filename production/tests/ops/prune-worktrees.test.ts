import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error — plain .mjs ops script, no types
import { run, plan, parseWorktreeList, parseArgs, unlinkJunction } from "../../scripts/ops/prune-worktrees.mjs";

/* R-1594 (18 Oct 2026): a temp repo with worktrees in every state, one of them holding a
   node_modules JUNCTION to a shared folder — the exact thing `git worktree remove --force` used
   to wipe. Proves: dry run removes nothing; --apply removes only merged + clean + unlocked ones;
   the shared folder and its file survive. */

type Row = { name: string; action: string; reason: string };

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

let tmp: string, repo: string, wts: string, shared: string, lockDir: string;
const silent = () => {};

function addWorktree(name: string, from = "manager-pardeep") {
  const p = path.join(wts, name);
  g(repo, "worktree", "add", "-q", "-b", `w-${name}`, p, from);
  return p;
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prune-wt-"));
  repo = path.join(tmp, "repo");
  wts = path.join(repo, ".claude", "worktrees");
  shared = path.join(tmp, "shared-node_modules");
  lockDir = path.join(tmp, "locks");
  fs.mkdirSync(path.join(repo, "production"), { recursive: true });
  fs.mkdirSync(shared);
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(shared, "keep-me.txt"), "shared");
  g(repo, "init", "-q", "-b", "manager-pardeep");
  g(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".claude/\n");
  fs.writeFileSync(path.join(repo, "production", ".gitignore"), "/node_modules\n");
  fs.writeFileSync(path.join(repo, "production", "a.txt"), "a\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "base");

  // merged + clean + shared junction → removed
  const done = addWorktree("agent-done");
  fs.symlinkSync(shared, path.join(done, "production", "node_modules"), "junction");
  // rebased then pushed: commit on its branch is in base with the same patch → removed
  const rebased = addWorktree("agent-rebased");
  fs.writeFileSync(path.join(rebased, "production", "r.txt"), "r\n");
  g(rebased, "add", "-A");
  g(rebased, "commit", "-q", "-m", "r");
  fs.writeFileSync(path.join(repo, "production", "other.txt"), "someone else's push\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "other worker");
  g(repo, "cherry-pick",g(rebased, "rev-parse", "HEAD").trim());
  // own unmerged commit → kept
  const open = addWorktree("agent-open");
  fs.writeFileSync(path.join(open, "production", "b.txt"), "b\n");
  g(open, "add", "-A");
  g(open, "commit", "-q", "-m", "open work");
  // merged but a modified file → kept
  const dirty = addWorktree("agent-dirty");
  fs.writeFileSync(path.join(dirty, "production", "a.txt"), "changed\n");
  // merged + clean but a worker holds a lock on it → kept
  const claimed = addWorktree("agent-claimed");
  fs.writeFileSync(path.join(lockDir, "R-1.json"), JSON.stringify({ card: "R-1", worktree: claimed }));
  // merged + clean but OUTSIDE .claude/worktrees (like the tester checkout) → never looked at
  g(repo, "worktree", "add", "-q", "-b", "w-outside", path.join(tmp, "outside-tester"), "manager-pardeep");
  // coordinator → kept even though merged + clean
  addWorktree("beautiful-ptolemy-abc123");
  // an extra link somewhere else → kept (git's recursive delete could reach outside)
  const odd = addWorktree("agent-oddlink");
  fs.symlinkSync(shared, path.join(odd, "production", "other-link"), "junction");
  fs.appendFileSync(path.join(odd, "production", ".gitignore"), "/other-link\n");
  g(odd, "add", "-A");
  g(odd, "commit", "-q", "-m", "ignore link");
  g(repo, "cherry-pick", g(odd, "rev-parse", "HEAD").trim());
}, 60_000);

afterAll(() => {
  // unlink links first (never recurse into the shared folder), then delete the temp tree
  for (const p of [path.join(wts, "agent-done", "production", "node_modules"), path.join(wts, "agent-oddlink", "production", "other-link")]) {
    try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch { /* already gone */ }
  }
  expect(fs.existsSync(path.join(shared, "keep-me.txt"))).toBe(true);
  fs.rmSync(tmp, { recursive: true, force: true });
}, 60_000);

const opts = () => ({ repo, base: "manager-pardeep", lockDir, minAgeHours: 0, self: tmp });
const byName = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.name, r]));

describe("prune-worktrees", { timeout: 30_000 }, () => {
  it("parses git worktree list --porcelain", () => {
    const rows = parseWorktreeList("worktree C:/r\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/r/.claude/worktrees/x\nHEAD def\ndetached\nlocked reason\n");
    expect(rows).toEqual([
      { path: "C:/r", head: "abc", branch: "main", locked: false, bare: false },
      { path: "C:/r/.claude/worktrees/x", head: "def", branch: null, locked: true, bare: false },
    ]);
  });

  it("parses options; dry run is the default", () => {
    expect(parseArgs([]).apply).toBe(false);
    expect(parseArgs(["--apply", "--min-age-hours", "0", "--keep", "X"])).toMatchObject({ apply: true, minAgeHours: 0, keep: ["X"] });
    expect(() => parseArgs(["--force"])).toThrow(/unknown option/);
  });

  it("plans: removes only merged + clean + unlocked, says why it keeps the rest", () => {
    const rows = byName(plan(opts()));
    expect(rows["agent-done"].action).toBe("remove");
    expect(rows["agent-rebased"]).toMatchObject({ action: "remove", reason: expect.stringContaining("same patches") });
    expect(rows["agent-open"]).toMatchObject({ action: "keep", reason: expect.stringContaining("not merged") });
    expect(rows["agent-dirty"]).toMatchObject({ action: "keep", reason: expect.stringContaining("uncommitted") });
    expect(rows["agent-claimed"]).toMatchObject({ action: "keep", reason: "worker-lock R-1" });
    expect(rows["outside-tester"]).toBeUndefined();
    expect(rows["beautiful-ptolemy-abc123"]).toMatchObject({ action: "keep", reason: "coordinator worktree" });
    expect(rows["agent-oddlink"]).toMatchObject({ action: "keep", reason: expect.stringContaining("other link") });
    expect(plan({ ...opts(), minAgeHours: 1000 }).every((r: Row) => r.action === "keep")).toBe(true);
  });

  it("dry run removes nothing", () => {
    const before = g(repo, "worktree", "list");
    run(opts(), silent);
    expect(g(repo, "worktree", "list")).toBe(before);
    expect(fs.lstatSync(path.join(wts, "agent-done", "production", "node_modules")).isSymbolicLink()).toBe(true);
  });

  it("refuses to unlink a real folder", () => {
    expect(() => unlinkJunction(path.join(wts, "agent-open"), "production")).toThrow(/real folder/);
    expect(fs.existsSync(path.join(wts, "agent-open", "production", "b.txt"))).toBe(true);
  });

  it("--apply removes the two, keeps the rest, and the shared junction target survives", () => {
    const res = run({ ...opts(), apply: true }, silent);
    expect(res.removed).toBe(2);
    expect(res.failed).toEqual([]);
    expect(fs.existsSync(path.join(wts, "agent-done"))).toBe(false);
    expect(fs.existsSync(path.join(wts, "agent-rebased"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "outside-tester", "production", "a.txt"))).toBe(true);
    for (const k of ["agent-open", "agent-dirty", "agent-claimed", "beautiful-ptolemy-abc123", "agent-oddlink"]) {
      expect(fs.existsSync(path.join(wts, k)), k).toBe(true);
    }
    expect(fs.readFileSync(path.join(shared, "keep-me.txt"), "utf8")).toBe("shared");
    expect(fs.readFileSync(path.join(wts, "agent-dirty", "production", "a.txt"), "utf8")).toBe("changed\n");
  });
});
