import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs ops script, no types
import { wipBranch, runWip, runResume, guardPush, pushEnv, PUSH_MODE_ENV, PUSH_CARD_ENV } from "../scripts/ops/worker-lock.mjs";

/** R-1898: a fake git — records every call, answers from a small table, throws where told. */
function fakeGit(answers: Record<string, string> = {}, fails: string[] = []) {
  const calls: { args: string[]; env?: Record<string, string> }[] = [];
  const git = (args: string[], opts: { env?: Record<string, string> } = {}) => {
    calls.push({ args, env: opts.env });
    const key = args.slice(0, 2).join(" ");
    if (fails.some((f) => key.startsWith(f) || args[0] === f)) { const e = new Error(`fake git failed: ${args.join(" ")}`); throw e; }
    return answers[key] ?? answers[args[0]] ?? "";
  };
  return { git, calls };
}

const SHA = "1111111111111111111111111111111111111111";

describe("R-1898: wip <CARD> — half-done work goes to anutech wip/<card>", () => {
  it("names the card's own branch, lower case, and refuses a non-card id", () => {
    expect(wipBranch("R-1898")).toBe("wip/r-1898");
    expect(wipBranch("r-7")).toBe("wip/r-7");
    expect(() => wipBranch("manager-pardeep")).toThrow();
    expect(() => wipBranch("R-12/../main")).toThrow();
  });

  it("refuses every branch name except the card's own wip branch — git is never asked to push", () => {
    for (const branch of ["manager-pardeep", "main", "deploy", "staging", "wip/r-1899", "refs/heads/main", "wip/r-18980", "w-r-1898"]) {
      const { git, calls } = fakeGit();
      const r = runWip("R-1898", { git, branch });
      expect(r.ok, branch).toBe(false);
      expect(calls.some((c) => c.args[0] === "push"), branch).toBe(false);
    }
  });

  it("first push creates wip/<card>: lease expects the branch NOT to exist yet", () => {
    const { git, calls } = fakeGit({ "rev-parse --short": "abc1234" });
    const r = runWip("R-1898", { git, env: {} });
    expect(r.ok).toBe(true);
    const push = calls.find((c) => c.args[0] === "push")!;
    expect(push.args).toEqual(["push", "-q", "--force-with-lease=refs/heads/wip/r-1898:", "anutech", "HEAD:refs/heads/wip/r-1898"]);
    expect(r.message).toContain('"branch": "wip/r-1898"');
    expect(r.sha).toBe("abc1234");
  });

  it("an update force-with-leases ONLY wip/<card>, pinned to the tip this clone last fetched/pushed (not a fresh ls-remote)", () => {
    const { git, calls } = fakeGit({ "rev-parse --verify": `${SHA}\n`, "ls-remote anutech": "2222222222222222222222222222222222222222\trefs/heads/wip/r-1898\n" });
    expect(runWip("R-1898", { git, env: {} }).ok).toBe(true);
    expect(calls.some((c) => c.args[0] === "ls-remote")).toBe(false);
    const push = calls.find((c) => c.args[0] === "push")!;
    const leases = push.args.filter((a) => a.startsWith("--force"));
    expect(leases).toEqual([`--force-with-lease=refs/heads/wip/r-1898:${SHA}`]);
    expect(push.args).not.toContain("--force");
    expect(push.args).not.toContain("-f");
    expect(push.args.filter((a) => a.includes(":")).every((a) => a.includes("wip/r-1898"))).toBe(true);
    expect(push.args).toContain("anutech");
    expect(push.args).not.toContain("origin");
    expect(push.env?.[PUSH_MODE_ENV]).toBe("wip");
    expect(push.env?.[PUSH_CARD_ENV]).toBe("R-1898");
  });

  it("a lease failure (a teammate pushed the same wip branch) is reported, not retried with force", () => {
    const { git, calls } = fakeGit({ "rev-parse --verify": SHA }, ["push"]);
    const r = runWip("R-1898", { git, env: {} });
    expect(r.ok).toBe(false);
    expect(calls.filter((c) => c.args[0] === "push")).toHaveLength(1);
  });

  it("warns when uncommitted files would be left behind", () => {
    const { git } = fakeGit({ "status --porcelain": " M src/x.ts" });
    expect(runWip("R-1898", { git, env: {} }).message).toContain("bina commit");
  });
});

describe("R-1898: resume <CARD> <worktree> — any member's laptop builds the worktree from wip/<card>", () => {
  it("fetches wip/<card> and creates the worktree on w-<card> from it", () => {
    const { git, calls } = fakeGit({ log: "abc1234 WIP R-1898: half" });
    const r = runResume("R-1898", "D:/work/reselleros-w-r-1898", { git, exists: () => false });
    expect(r.ok).toBe(true);
    expect(calls[0].args).toEqual(["fetch", "-q", "anutech", "+refs/heads/wip/r-1898:refs/remotes/anutech/wip/r-1898"]);
    expect(calls[1].args).toEqual(["worktree", "add", "D:/work/reselleros-w-r-1898", "-b", "w-r-1898", "anutech/wip/r-1898"]);
    expect(r.message).toContain("picked up from");
    expect(r.message).toContain("claim R-1898");
    expect(calls.some((c) => c.args[0] === "push")).toBe(false);
  });

  it("no wip branch on GitHub → nothing to resume, no worktree", () => {
    const { git, calls } = fakeGit({}, ["fetch"]);
    const r = runResume("R-1898", "D:/w", { git, exists: () => false });
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.args[0] === "worktree")).toBe(false);
  });

  it("refuses an existing folder and a missing path", () => {
    const { git, calls } = fakeGit();
    expect(runResume("R-1898", "D:/w", { git, exists: () => true }).ok).toBe(false);
    expect(runResume("R-1898", "", { git, exists: () => false }).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("R-1898: push guard — wip/* only through the wip command", () => {
  const line = (ref: string) => `refs/heads/w-r-1898 ${SHA} refs/heads/${ref} 0000000000000000000000000000000000000000`;

  it("refuses a manual push to any wip branch", () => {
    expect(guardPush([line("wip/r-1898")], {}).ok).toBe(false);
    expect(guardPush([line("wip/r-1899")], {}).ok).toBe(false);
  });

  it("refuses the wip command pushing ANOTHER card's wip branch", () => {
    expect(guardPush([line("wip/r-1899")], pushEnv("wip", "R-1898", {})).ok).toBe(false);
    expect(guardPush([line("wip/r-1898"), line("wip/r-1899")], pushEnv("wip", "R-1898", {})).ok).toBe(false);
  });

  it("lets the wip command push its own card's branch", () => {
    expect(guardPush([line("wip/r-1898")], pushEnv("wip", "R-1898", {})).ok).toBe(true);
  });

  it("manager-pardeep only from push; wip mode cannot reach it", () => {
    expect(guardPush([line("manager-pardeep")], {}).ok).toBe(false);
    expect(guardPush([line("manager-pardeep")], pushEnv("wip", "R-1898", {})).ok).toBe(false);
    expect(guardPush([line("manager-pardeep")], pushEnv("push", "R-1898", {})).ok).toBe(true);
  });

  it("worker-lock push tells the guard it is the push command", () => {
    const src = readFileSync(path.join(__dirname, "..", "scripts", "ops", "worker-lock.mjs"), "utf8");
    const push = src.slice(src.indexOf("async function pushWithTurn"));
    expect(push.slice(0, push.indexOf("pushDoneLine"))).toMatch(/git push -q anutech HEAD:manager-pardeep", pushEnv\("push", card\)/);
  });
});
