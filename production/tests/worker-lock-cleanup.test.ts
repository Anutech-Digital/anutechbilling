import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error — plain .mjs ops script, no types
import { runCleanup, parseCleanupFlags, realCleanupDeps, inspectNodeModules, worktreeBranch, CLEANUP_EXIT } from "../scripts/ops/worker-lock-cleanup.mjs";

/**
 * R-2385 (2 Nov 2026): a worker cleanup deleted files inside the SHARED reselleros-deploy/production/node_modules
 * through its worktree's junction (@auth/core lost package.json) → localhost Build Error. `worker-lock cleanup`
 * removes the LINK first and checks it is gone before anything recursive (git worktree remove) runs.
 */
const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

/** tmp/{shared/node_modules/@auth/core/package.json, main/.git, wt/production/{node_modules→shared, .env.local, src.ts}} */
function setup({ realDir = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r2385-"));
  tmps.push(root);
  const shared = path.join(root, "shared", "node_modules");
  fs.mkdirSync(path.join(shared, "@auth", "core"), { recursive: true });
  fs.writeFileSync(path.join(shared, "@auth", "core", "package.json"), "{}");
  fs.mkdirSync(path.join(root, "main", ".git"), { recursive: true });
  const wt = path.join(root, "wt");
  fs.mkdirSync(path.join(wt, "production"), { recursive: true });
  fs.writeFileSync(path.join(wt, "production", ".env.local"), "X=1");
  fs.writeFileSync(path.join(wt, "production", "src.ts"), "x");
  const nm = path.join(wt, "production", "node_modules");
  if (realDir) { fs.mkdirSync(path.join(nm, "pkg"), { recursive: true }); fs.writeFileSync(path.join(nm, "pkg", "index.js"), ""); }
  else fs.symlinkSync(shared, nm, process.platform === "win32" ? "junction" : "dir");
  return { root, shared, wt, nm, main: path.join(root, "main"), sharedFile: path.join(shared, "@auth", "core", "package.json") };
}

/** Real fs + the real link remover; a fake git whose `worktree remove` is a RECURSIVE delete (the dangerous part). */
function deps(s: ReturnType<typeof setup>, { merged = true, wip = false, branch = true, keepLink = false, checkedOut = "w-r-2385" as string | null } = {}) {
  const real = realCleanupDeps();
  const calls: string[][] = [];
  const out: string[] = [];
  const git = (args: string[]) => {
    calls.push(args);
    const a = args.slice(2).join(" ");
    if (a.startsWith("rev-parse --path-format=absolute --git-common-dir")) return path.join(s.main, ".git") + "\n";
    /* R-2561: git lists every worktree; only THIS one's branch may be deleted. */
    if (a.startsWith("worktree list --porcelain")) return [
      `worktree ${s.main}`, "HEAD 111", "branch refs/heads/preview-0210", "",
      `worktree ${s.wt}`, "HEAD 222", checkedOut ? `branch refs/heads/${checkedOut}` : "detached", "",
      `worktree ${path.join(s.root, "old-wt")}`, "HEAD 333", "branch refs/heads/w-r-2385-old", "",
    ].join("\n");
    if (a.startsWith("worktree remove")) { fs.rmSync(args[4], { recursive: true, force: true }); return ""; }
    if (a.startsWith("rev-parse --verify --quiet refs/heads/")) { if (!branch) throw new Error("no"); return "abc\n"; }
    if (a.startsWith("rev-parse --verify --quiet refs/remotes/anutech/wip/")) { if (!wip) throw new Error("no"); return "abc\n"; }
    if (a.startsWith("merge-base --is-ancestor")) { if (!merged) throw new Error("no"); return ""; }
    return "";
  };
  return {
    calls, out,
    d: { ...real, cwd: () => s.root, chdir: () => {}, git, rmdirLink: keepLink ? () => {} : real.rmdirLink, print: (l: string) => out.push(l), printErr: (l: string) => out.push(l) },
  };
}

describe("R-2385: worker-lock cleanup never deletes through the node_modules junction", () => {
  it("removes the link FIRST, then .env.local, then git worktree remove (no --force) — the shared files survive", () => {
    const s = setup();
    const { d, calls, out } = deps(s);
    const r = runCleanup("R-2385", { worktree: s.wt }, d);
    expect(r.code).toBe(CLEANUP_EXIT.ok);
    expect(fs.existsSync(s.sharedFile)).toBe(true); // the 2 Nov damage did not happen
    expect(fs.existsSync(s.wt)).toBe(false);
    const remove = calls.find((c) => c.includes("worktree") && c.includes("remove"))!;
    expect(remove).toEqual(["-C", s.main, "worktree", "remove", path.resolve(s.wt)]);
    expect(calls.flat()).not.toContain("--force");
    expect(calls.some((c) => c.join(" ").includes("branch -D w-r-2385"))).toBe(true);
    const i = (re: RegExp) => out.findIndex((l) => re.test(l));
    expect(i(/SIRF link hatega/)).toBeGreaterThanOrEqual(0);
    expect(i(/SIRF link hatega/)).toBeLessThan(i(/\.env\.local hatega/));
    expect(i(/\.env\.local hatega/)).toBeLessThan(i(/worktree remove/));
  });

  it("REFUSES when node_modules is a real folder with files — nothing is deleted, git is never asked to remove", () => {
    const s = setup({ realDir: true });
    const { d, calls, out } = deps(s);
    const r = runCleanup("R-2385", { worktree: s.wt }, d);
    expect(r.code).toBe(CLEANUP_EXIT.refused);
    expect(out.join("\n")).toMatch(/asli folder hai/);
    expect(fs.existsSync(path.join(s.nm, "pkg", "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(s.wt, "production", ".env.local"))).toBe(true);
    expect(calls.some((c) => c.includes("worktree") && c.includes("remove"))).toBe(false);
  });

  it("REFUSES when the junction is still there after rmdir — worktree remove never runs", () => {
    const s = setup();
    const { d, calls } = deps(s, { keepLink: true });
    const r = runCleanup("R-2385", { worktree: s.wt }, d);
    expect(r.code).toBe(CLEANUP_EXIT.refused);
    expect(calls.some((c) => c.includes("worktree") && c.includes("remove"))).toBe(false);
    expect(inspectNodeModules(s.nm, d).kind).toBe("link");
    expect(fs.existsSync(s.sharedFile)).toBe(true);
  });

  it("keeps the branch when it is neither merged nor on anutech/wip/<card>", () => {
    const s = setup();
    const { d, calls, out } = deps(s, { merged: false, wip: false });
    expect(runCleanup("R-2385", { worktree: s.wt }, d).code).toBe(CLEANUP_EXIT.ok);
    expect(calls.some((c) => c.includes("-D"))).toBe(false);
    expect(out.join("\n")).toMatch(/branch w-r-2385 RAKHA/);
  });

  it("deletes the branch when a wip branch holds it", () => {
    const s = setup();
    const { d, calls } = deps(s, { merged: false, wip: true });
    expect(runCleanup("R-2385", { worktree: s.wt }, d).code).toBe(CLEANUP_EXIT.ok);
    expect(calls.some((c) => c.join(" ").endsWith("branch -D w-r-2385"))).toBe(true);
  });

  it("--dry-run prints the steps and changes nothing", () => {
    const s = setup();
    const { d, calls, out } = deps(s);
    const r = runCleanup("R-2385", { worktree: s.wt, dryRun: true }, d);
    expect(r.code).toBe(CLEANUP_EXIT.ok);
    expect(inspectNodeModules(s.nm, d).kind).toBe("link");
    expect(fs.existsSync(path.join(s.wt, "production", ".env.local"))).toBe(true);
    expect(calls.some((c) => c.includes("remove") || c.includes("-D"))).toBe(false);
    expect(out.join("\n")).toMatch(/\[dry-run\] kuch nahi badla/);
  });

  it("refuses the main clone itself", () => {
    const s = setup();
    const { d, calls } = deps(s);
    const git = d.git;
    d.git = (args: string[]) => (args.join(" ").includes("git-common-dir") ? path.join(s.wt, ".git") + "\n" : git(args));
    expect(runCleanup("R-2385", { worktree: s.wt }, d).code).toBe(CLEANUP_EXIT.refused);
    expect(calls.some((c) => c.includes("worktree") && c.includes("remove"))).toBe(false);
    expect(fs.existsSync(s.sharedFile)).toBe(true);
  });

  it("parses --worktree and --dry-run", () => {
    expect(parseCleanupFlags(["--worktree", "C:/x", "--dry-run"])).toEqual({ worktree: "C:/x", dryRun: true, rest: [] });
    expect(parseCleanupFlags(["--worktree=C:/y"])).toEqual({ worktree: "C:/y", dryRun: false, rest: [] });
  });
});

/* R-2561 (7 Nov 2026): R-1495's worker used branch w-r-1495b; `cleanup R-1495` built the name w-r-1495 from the
   card id and would have deleted an OLDER w-r-1495 from a past worker. Only the branch checked out in THIS
   worktree (git worktree list --porcelain) may go. */
describe("R-2561: cleanup deletes only the branch of THIS worktree", () => {
  const deleted = (calls: string[][]) => calls.filter((c) => c.includes("-D")).map((c) => c[c.length - 1]);

  it("worker used w-r-2385b → only w-r-2385b is deleted, never w-r-2385 (same card, other worker) or other branches", () => {
    const s = setup();
    const { d, calls } = deps(s, { checkedOut: "w-r-2385b" });
    expect(runCleanup("R-2385", { worktree: s.wt }, d).code).toBe(CLEANUP_EXIT.ok);
    expect(deleted(calls)).toEqual(["w-r-2385b"]);
    expect(calls.some((c) => c.includes("refs/heads/w-r-2385"))).toBe(false);
    // the merged / wip checks were asked about the worktree's own branch
    expect(calls.some((c) => c.join(" ").includes("merge-base --is-ancestor w-r-2385b"))).toBe(true);
  });

  it("reads the branch BEFORE the worktree is removed (git no longer lists it afterwards)", () => {
    const s = setup();
    const { d, calls } = deps(s);
    runCleanup("R-2385", { worktree: s.wt }, d);
    const list = calls.findIndex((c) => c.includes("list") && c.includes("--porcelain"));
    const remove = calls.findIndex((c) => c.includes("worktree") && c.includes("remove"));
    expect(list).toBeGreaterThanOrEqual(0);
    expect(list).toBeLessThan(remove);
  });

  it("detached HEAD in the worktree → no branch deleted at all (no guessing from the card id)", () => {
    const s = setup();
    const { d, calls, out } = deps(s, { checkedOut: null });
    expect(runCleanup("R-2385", { worktree: s.wt }, d).code).toBe(CLEANUP_EXIT.ok);
    expect(deleted(calls)).toEqual([]);
    expect(out.join("\n")).toMatch(/koi branch nahi hategi/);
  });

  it("git worktree list failing → no branch deleted", () => {
    const s = setup();
    const { d, calls } = deps(s);
    const git = d.git;
    d.git = (args: string[]) => { if (args.includes("list")) { calls.push(args); throw new Error("git broke"); } return git(args); };
    expect(runCleanup("R-2385", { worktree: s.wt }, d).code).toBe(CLEANUP_EXIT.ok);
    expect(deleted(calls)).toEqual([]);
  });

  it("worktreeBranch: matches the path (case-insensitive on Windows, any slash), detached → null, unlisted → null", () => {
    const porcelain = [
      "worktree C:/Users/me/new-reselleros", "HEAD 1", "branch refs/heads/preview-0210", "",
      "worktree C:/Users/me/reselleros-w-r-1495", "HEAD 2", "branch refs/heads/w-r-1495b", "",
      "worktree C:/Users/me/reselleros-w-r-1496", "HEAD 3", "detached", "",
    ].join("\r\n");
    if (process.platform === "win32") {
      expect(worktreeBranch(porcelain, "c:\\users\\ME\\reselleros-w-r-1495\\", "win32")).toBe("w-r-1495b");
      expect(worktreeBranch(porcelain, "C:/Users/me/reselleros-w-r-1496", "win32")).toBeNull();
      expect(worktreeBranch(porcelain, "C:/Users/me/reselleros-w-r-149", "win32")).toBeNull();
    }
    const posix = "worktree /home/me/wt-a\nHEAD 1\nbranch refs/heads/w-r-1/x\n\nworktree /home/me/wt-ab\nHEAD 2\nbranch refs/heads/w-r-1b\n";
    expect(worktreeBranch(posix, "/home/me/wt-ab", "linux")).toBe("w-r-1b");
    expect(worktreeBranch(posix, "/home/me/wt-a", "linux")).toBe("w-r-1/x");
    expect(worktreeBranch(posix, "/home/me/wt", "linux")).toBeNull();
    expect(worktreeBranch("", "/home/me/wt-a", "linux")).toBeNull();
  });
});
