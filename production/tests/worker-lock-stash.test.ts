import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs ops script, no types
import { readStash, stashSnapshot, stashVerdict, stashBranch, enforceStash, STASH_EXIT } from "../scripts/ops/worker-lock-stash.mjs";

/**
 * R-2356 (2 Nov 2026): the R-2355 worker ran `git stash` + `git stash pop` on a clean tree and got
 * R-2225's WIP (stash@{0}) applied into its worktree — every worktree shares ONE stash list. `claim`
 * now records the stash list; `check`/`push` stop when an entry was added since the claim.
 */
const OTHER = "d80462ea01fb2bf01077a2eb286f6452d521838a\tWIP on w-r-2225: b8836fb94 WIP R-2225: half done";
const OLDER = "3c0fb8bc233d31f799d2a428921ff19c277dd145\tWIP on w-r-1704: 00c87d52 R-1697: subs";
const MINE = "5555555555555555555555555555555555555555\tWIP on w-r-2356: 1234567 R-2356: wip";
const MINE_MSG = "6666666666666666666666666666666666666666\tOn w-r-2356: before rebase";
const DETACHED = "7777777777777777777777777777777777777777\tWIP on (no branch): 1234567 x";
const THIRD = "8888888888888888888888888888888888888888\tWIP on w-r-2400: 1234567 R-2400: wip";

/** A fake git that answers `stash list` with the given lines and records every call. */
function fakeGit(lines: string[] | Error) {
  const calls: string[][] = [];
  const git = (args: string[]) => {
    calls.push(args);
    if (lines instanceof Error) throw lines;
    return lines.length ? lines.join("\n") + "\n" : "";
  };
  return { git, calls };
}

const verdict = (before: string[], now: string[], branch = "w-r-2356") =>
  stashVerdict({ card: "R-2356", branch, atClaim: stashSnapshot(fakeGit(before).git, "2026-11-02T01:55:00Z"), now: readStash(fakeGit(now).git) });

describe("R-2356: worker-lock stash guard", () => {
  it("reads the shared stash list with git stash list only — never pop/apply/drop/clear", () => {
    const { git, calls } = fakeGit([OTHER, OLDER]);
    const s = readStash(git);
    expect(s).toEqual([
      { sha: OTHER.slice(0, 40), subject: OTHER.slice(41), branch: "w-r-2225" },
      { sha: OLDER.slice(0, 40), subject: OLDER.slice(41), branch: "w-r-1704" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 2)).toEqual(["stash", "list"]);
    expect(calls.flat().some((a) => /^(pop|apply|drop|clear|push|save)$/.test(a))).toBe(false);
  });

  it("names the branch of each entry (WIP on / On / detached)", () => {
    expect(stashBranch("WIP on w-r-2356: abc x")).toBe("w-r-2356");
    expect(stashBranch("On w-r-2356: before rebase")).toBe("w-r-2356");
    expect(stashBranch("WIP on (no branch): abc x")).toBe(null);
    expect(stashBranch("something odd")).toBe(null);
  });

  it("no new stash since claim → ok (others' old entries are left alone, no stop)", () => {
    const r = verdict([OTHER, OLDER], [OTHER, OLDER]);
    expect(r.ok).toBe(true);
    expect(r.warn).toEqual([]);
  });

  it("empty stash list both times → ok", () => {
    expect(verdict([], []).ok).toBe(true);
  });

  it("new stash on THIS card's branch since claim → stop, says commit a WIP and never pop others' entries", () => {
    const r = verdict([OTHER, OLDER], [MINE, OTHER, OLDER]);
    expect(r.ok).toBe(false);
    expect(r.exit).toBe(STASH_EXIT);
    expect(r.message).toMatch(/git stash/);
    expect(r.message).toMatch(/WIP/);
    expect(r.message).toMatch(/wip R-2356/);
    expect(r.message).toMatch(/pop/);
    expect(r.message).toContain("w-r-2356");
    expect(r.message).not.toContain("w-r-2225:");
  });

  it("a stash -m on this branch (\"On w-r-2356: …\") also stops", () => {
    expect(verdict([], [MINE_MSG]).ok).toBe(false);
  });

  it("a new detached-HEAD stash since claim stops too (could be this worker's — branch unknown)", () => {
    expect(verdict([OTHER], [DETACHED, OTHER]).ok).toBe(false);
  });

  it("a new stash on ANOTHER worker's branch only warns — it is theirs, not this card's", () => {
    const r = verdict([OTHER], [THIRD, OTHER]);
    expect(r.ok).toBe(true);
    expect(r.warn.join("\n")).toMatch(/w-r-2400/);
  });

  it("an entry present at claim that is now gone (popped/dropped) warns — the R-2355 near miss", () => {
    const r = verdict([OTHER, OLDER], [OLDER]);
    expect(r.ok).toBe(true);
    expect(r.warn.join("\n")).toMatch(/w-r-2225/);
    expect(r.warn.join("\n")).toMatch(/pop|drop/);
  });

  it("old lock without a claim snapshot: an entry naming this card's branch still stops, others pass", () => {
    const now = readStash(fakeGit([MINE, OTHER]).git);
    expect(stashVerdict({ card: "R-2356", branch: "w-r-2356", atClaim: undefined, now }).ok).toBe(false);
    const clean = readStash(fakeGit([OTHER]).git);
    expect(stashVerdict({ card: "R-2356", branch: "w-r-2356", atClaim: undefined, now: clean }).ok).toBe(true);
  });

  it("branch defaults to w-<card lowercase> when git gives none (detached worktree)", () => {
    const now = readStash(fakeGit([MINE]).git);
    expect(stashVerdict({ card: "R-2356", branch: "", atClaim: { shas: [] }, now }).ok).toBe(false);
  });

  it("git failing → never blocks (warn only), and the snapshot is null", () => {
    const boom = fakeGit(new Error("git not found")).git;
    expect(readStash(boom)).toBe(null);
    expect(stashSnapshot(boom, "2026-11-02T01:55:00Z")).toBe(null);
    const r = stashVerdict({ card: "R-2356", branch: "w-r-2356", atClaim: { shas: [] }, now: null });
    expect(r.ok).toBe(true);
    expect(r.warn.length).toBe(1);
  });

  it("snapshot records the shas, subjects and time; exit code is 10 (worker-lock's 9 is the scope guard)", () => {
    const s = stashSnapshot(fakeGit([OTHER]).git, "2026-11-02T01:55:00Z");
    expect(s).toEqual({ at: "2026-11-02T01:55:00Z", shas: [OTHER.slice(0, 40)], subjects: { [OTHER.slice(0, 40)]: OTHER.slice(41) } });
    expect(STASH_EXIT).toBe(10);
  });
});

describe("R-2356: with real git in a throw-away repo (its own stash list, never the shared one)", () => {
  it("claim snapshot → a stash made afterwards on the card's branch stops; a clean list passes", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "r2356-stash-"));
    try {
      const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      git(["init", "-q", "-b", "w-r-2356"]);
      writeFileSync(join(dir, "a.txt"), "one\n");
      git(["add", "a.txt"]);
      git(["commit", "-q", "-m", "base"]);
      const atClaim = stashSnapshot(git, "2026-11-02T01:55:00Z");
      expect(atClaim.shas).toEqual([]);
      expect(stashVerdict({ card: "R-2356", branch: "w-r-2356", atClaim, now: readStash(git) }).ok).toBe(true);
      writeFileSync(join(dir, "a.txt"), "two\n");
      git(["stash", "push", "-q", "-m", "oops"]);
      const now = readStash(git);
      expect(now).toHaveLength(1);
      expect(now[0].branch).toBe("w-r-2356");
      const r = stashVerdict({ card: "R-2356", branch: "w-r-2356", atClaim, now });
      expect(r.ok).toBe(false);
      expect(r.exit).toBe(STASH_EXIT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("R-2356: enforceStash — what check/push call", () => {
  const run = (before: string[], now: string[], branchOut = "w-r-2356\n") => {
    const out: string[] = [], err: string[] = [], exits: number[] = [];
    const { git: gitNow, calls } = fakeGit(now);
    const git = (args: string[]) => (args[0] === "rev-parse" ? branchOut : gitNow(args));
    const lock = { card: "R-2356", stashAtClaim: stashSnapshot(fakeGit(before).git, "2026-11-02T01:55:00Z") };
    enforceStash("R-2356", lock, { git, print: (l: string) => out.push(l), printErr: (l: string) => err.push(l), exit: (c: number) => exits.push(c) });
    return { out, err, exits, calls };
  };

  it("no new stash since claim → no exit, nothing printed", () => {
    const r = run([OTHER, OLDER], [OTHER, OLDER]);
    expect(r.exits).toEqual([]);
    expect(r.err).toEqual([]);
  });

  it("new stash on this branch since claim → exit 10 with the message; git only listed, never changed the stash", () => {
    const r = run([OTHER], [MINE, OTHER]);
    expect(r.exits).toEqual([STASH_EXIT]);
    expect(r.err.join("\n")).toMatch(/git stash mat chalao/);
    expect(r.calls.flat().some((a) => /^(pop|apply|drop|clear|push|save)$/.test(a))).toBe(false);
  });

  it("lock file path that cannot be read → branch rule only (old lock): others' entries pass", () => {
    const exits: number[] = [];
    const git = (args: string[]) => (args[0] === "rev-parse" ? "w-r-2356\n" : OTHER + "\n");
    enforceStash("R-2356", "Z:/no/such/R-2356.json", { git, print: () => {}, printErr: () => {}, exit: (c: number) => exits.push(c) });
    expect(exits).toEqual([]);
  });
});
