import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
// @ts-expect-error — plain .mjs ops script, no types
import { isDerived, withoutDerived, newestDeployDate, refreshDerived, rebaseResolvingDerived } from "../scripts/ops/worker-lock-derived.mjs";
// @ts-expect-error — plain .mjs ops script, no types
import { findConflicts, settleCiWaitLocks, ciWaitVerdict, LOCK_STATES } from "../scripts/ops/worker-lock.mjs";

/*
 * R-2105 (29 Oct 2026): every card with a migration held peeks.generated.ts + deploy-db-*.sh through
 * ci-wait (~45–60 min); R-2101 waited ~1 h behind R-2099, R-2102 1 h+ behind R-2101. Those files are
 * derived from supabase/migrations, so they never clash: push regenerates them after the rebase, and a
 * ci-wait lock whose CI is already green no longer blocks.
 */
const root = path.resolve(__dirname, "..");
const DEPLOY = "supabase/cloudsql/staging/deploy-db-2026-10-07.sh";
const DEPLOY_LIVE = "supabase/cloudsql/live/deploy-db-2026-10-07.sh";
const PEEKS = "src/server/migrations-health/peeks.generated.ts";

describe("R-2105: derived files never clash", () => {
  it("knows exactly the files gen-deploy-db writes, whatever the prefix or slashes", () => {
    expect(isDerived(`production/${DEPLOY}`)).toBe(true);
    expect(isDerived(DEPLOY_LIVE.replace(/\//g, "\\"))).toBe(true);
    expect(isDerived(`production/${PEEKS}`)).toBe(true);
    expect(isDerived("supabase/migrations/20261029120000_x.sql")).toBe(false);
    expect(isDerived("src/server/migrations-health/route.ts")).toBe(false);
    expect(isDerived("supabase/cloudsql/staging/r909-live-db.sh")).toBe(false);
    expect(withoutDerived([DEPLOY, "src/lib/x/a.ts", PEEKS])).toEqual(["src/lib/x/a.ts"]);
  });

  it("the 29 Oct case: a ci-wait card holding the generated files does not block the next migration card", () => {
    const locks = [{ card: "R-2101", areas: ["src/lib/billing"], files: [DEPLOY, DEPLOY_LIVE, PEEKS, "supabase/migrations/20261029100000_a.sql"], state: LOCK_STATES.ciWait }];
    expect(findConflicts("R-2102", [DEPLOY, DEPLOY_LIVE, PEEKS, "supabase/migrations/20261029110000_b.sql"], locks)).toEqual([]);
    /* real code still clashes */
    expect(findConflicts("R-2102", ["src/lib/billing/x.ts"], locks)).toHaveLength(1);
  });

  it("the newest date with BOTH a staging and a live script is the one regenerated", () => {
    expect(newestDeployDate(["deploy-db-2026-10-05.sh", "deploy-db-2026-10-07.sh", "deploy-db-2026-10-09.sh", "x.sh"], ["deploy-db-2026-10-07.sh"])).toBe("2026-10-07");
    expect(newestDeployDate([], [])).toBe(null);
  });
});

describe("R-2105: a ci-wait lock whose CI is green frees itself in claim/check", () => {
  const sha = "a".repeat(40), later = "b".repeat(40);
  const run = (id: number, wf: string, head: string, conclusion: string, status = "completed") =>
    ({ databaseId: id, workflowName: wf, status, conclusion, headSha: head, url: `u/${id}`, createdAt: `2026-10-29T1${id}:00:00Z` });
  const fakeGh = (shaRuns: unknown[], branchRuns: unknown[]) => (args: string[]) => JSON.stringify(args.includes("--commit") ? shaRuns : branchRuns);
  const ciWait = { card: "R-2101", areas: ["src/lib/billing"], files: [], state: LOCK_STATES.ciWait, pushedSha: sha };

  it("green on its own sha → green; red → red; still running → pending; not ci-wait → null", () => {
    const isAncestor = () => false;
    expect(ciWaitVerdict(ciWait, { gh: fakeGh([run(1, "CI", sha, "success")], []), isAncestor })).toBe("green");
    expect(ciWaitVerdict(ciWait, { gh: fakeGh([run(1, "CI", sha, "failure")], []), isAncestor })).toBe("red");
    expect(ciWaitVerdict(ciWait, { gh: fakeGh([run(1, "CI", sha, "", "in_progress")], []), isAncestor })).toBe("pending");
    expect(ciWaitVerdict({ ...ciWait, state: "working" }, { gh: fakeGh([], []), isAncestor })).toBe(null);
    expect(ciWaitVerdict(ciWait, { gh: () => { throw new Error("offline"); }, isAncestor })).toBe(null);
  });

  it("own run cancelled by the next push → the later run that contains the sha decides", () => {
    const gh = fakeGh([run(1, "CI", sha, "cancelled")], [run(2, "CI", later, "success"), run(1, "CI", sha, "cancelled")]);
    expect(ciWaitVerdict(ciWait, { gh, isAncestor: (a: string, b: string) => a === sha && b === later })).toBe("green");
  });

  it("settle removes only the blocking ci-wait lock with green CI, and the clash is gone", () => {
    const removed: string[] = [];
    const red = { ...ciWait, card: "R-2099", areas: ["src/lib/other"], pushedSha: later };
    const gh = (args: string[]) => JSON.stringify(args.includes("--commit") ? [run(1, "CI", args[args.indexOf("--commit") + 1], args.includes(sha) ? "success" : "failure")] : []);
    const left = settleCiWaitLocks("R-2102", ["src/lib/billing/x.ts", "src/lib/other/y.ts"], [ciWait, red], { gh, isAncestor: () => false, remove: (c: string) => removed.push(c) });
    expect(removed).toEqual(["R-2101"]);
    expect(left.map((l: { card: string }) => l.card)).toEqual(["R-2099"]);
  });

  it("a ci-wait lock that is not in the way is never looked up", () => {
    let calls = 0;
    settleCiWaitLocks("R-2102", ["src/lib/mine"], [ciWait], { gh: () => { calls++; return "[]"; }, isAncestor: () => false, remove: () => {} });
    expect(calls).toBe(0);
  });
});

describe("R-2105: wiring in worker-lock.mjs", () => {
  const src = fs.readFileSync(path.join(root, "scripts", "ops", "worker-lock.mjs"), "utf8");
  it("push: rebase resolves derived conflicts, then regenerates BEFORE the commits are read, tsc and guard tests run", () => {
    const push = src.slice(src.indexOf("async function pushWithTurn"), src.indexOf("R-1898 (25 Oct 2026)"));
    const rb = push.indexOf("rebaseResolvingDerived("), refresh = push.indexOf("refreshDerived(card");
    expect(rb).toBeGreaterThan(-1);
    expect(refresh).toBeGreaterThan(rb);
    expect(refresh).toBeLessThan(push.indexOf("pushPlan(card"));
    expect(refresh).toBeLessThan(push.indexOf("runGuardSuites(card)"));
    expect(push).not.toMatch(/sh\("git rebase -q/);
  });
  it("claim and check settle green ci-wait locks first; check keeps derived files out of the lock", () => {
    expect(src.match(/settleCiWaitLocks\(card, (areas|files), /g)).toHaveLength(2);
    expect(src).toMatch(/const files = withoutDerived\(changedFiles\(\)\)/);
  });
});

/* Two worktrees each adding a migration (the card's howToCheck), on a throwaway git repo with the REAL generator. */
describe("R-2105: push rebase regenerates deploy-db + peeks with both cards' migrations", () => {
  let dir: string;
  const g = (args: string[], opts: { env?: NodeJS.ProcessEnv } = {}) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...(opts.env ? { env: opts.env } : {}) });
  const app = () => path.join(dir, "production");
  const regen = () => { execFileSync(process.execPath, [path.join(app(), "scripts", "ops", "gen-deploy-db.mjs"), "--date", "2026-10-07"], { cwd: app(), stdio: "pipe" }); };
  const write = (rel: string, text: string) => { const f = path.join(app(), rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  const read = (rel: string) => fs.readFileSync(path.join(app(), rel), "utf8");
  const mig = (v: string, key: string) => write(`supabase/migrations/${v}_${key}.sql`, `-- deploy-peek: to_regclass('public.${key}') is not null\ncreate table ${key}(id int);\n`);
  const script = (env: string) => `#!/bin/bash\n# ${env}\nMIGS=(\n)\necho done\n`;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r2105-"));
    g(["init", "-q", "-b", "main"]);
    g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "t"]); g(["config", "core.autocrlf", "false"]);
    fs.mkdirSync(path.join(app(), "scripts", "ops"), { recursive: true });
    fs.copyFileSync(path.join(root, "scripts", "ops", "gen-deploy-db.mjs"), path.join(app(), "scripts", "ops", "gen-deploy-db.mjs"));
    write(DEPLOY, script("staging")); write(DEPLOY_LIVE, script("live")); write(PEEKS, "");
    mig("20261029090000", "base0");
    execFileSync(process.execPath, [path.join(app(), "scripts", "ops", "gen-deploy-db.mjs"), "--date", "2026-10-07", "--since", "20261029090000"], { cwd: app(), stdio: "pipe" });
    g(["add", "-A"]); g(["commit", "-q", "-m", "base"]);
    g(["branch", "cardb"]);
    /* card A pushes first (it now sits in ci-wait): migration + regenerated files */
    mig("20261029100000", "carda"); regen();
    g(["add", "-A"]); g(["commit", "-q", "-m", "R-2101: card A"]);
    g(["branch", "upstream"]);
    /* card B, built from the old base, adds its own migration */
    g(["checkout", "-q", "cardb"]);
    mig("20261029110000", "cardbb"); regen();
    write("src/lib/b/x.ts", "export const b = 1;\n");
    g(["add", "-A"]); g(["commit", "-q", "-m", "R-2102: card B"]);
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("conflict only in generated files → resolved, both migrations in staging, live and peeks", () => {
    const r = rebaseResolvingDerived("upstream", { git: g, regen });
    expect(r).toMatchObject({ ok: true, resolved: 1 });
    for (const f of [DEPLOY, DEPLOY_LIVE, PEEKS]) {
      expect(read(f), f).toContain("carda");
      expect(read(f), f).toContain("cardbb");
    }
    expect(g(["log", "--format=%s", "upstream..HEAD"]).trim()).toBe("R-2102: card B");
    expect(g(["status", "--porcelain"]).trim()).toBe("");
    /* afterwards nothing is left to regenerate */
    expect(refreshDerived("R-2102", { git: g, regen })).toMatchObject({ how: "none" });
  });

  it("a conflict in real code still aborts and names the file", () => {
    g(["checkout", "-q", "upstream"]); write("src/lib/b/x.ts", "export const b = 2;\n"); g(["add", "-A"]); g(["commit", "-q", "-m", "R-2101: x"]); g(["branch", "-f", "upstream2"]);
    g(["checkout", "-q", "cardb"]);
    const before = g(["rev-parse", "HEAD"]).trim();
    const r = rebaseResolvingDerived("upstream2", { git: g, regen });
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual(["production/src/lib/b/x.ts"]);
    expect(g(["rev-parse", "HEAD"]).trim()).toBe(before);
    expect(fs.existsSync(path.join(dir, ".git", "rebase-merge"))).toBe(false);
  });

  it("stale generated files after a clean rebase are folded into the card's own commit", () => {
    write(DEPLOY, g(["show", `HEAD~1:production/${DEPLOY}`])); g(["add", "-A"]); g(["commit", "-q", "--amend", "--no-edit"]);
    const r = refreshDerived("R-2102", { git: g, regen });
    expect(r.how).toBe("amend");
    expect(g(["log", "-1", "--format=%s"]).trim()).toBe("R-2102: card B");
    expect(read(DEPLOY)).toContain("cardbb");
    expect(g(["status", "--porcelain"]).trim()).toBe("");
  });
});
