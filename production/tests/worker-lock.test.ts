import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
// @ts-expect-error — plain .mjs ops script, no types
import { migrationOrderGate, normaliseClaimAreas } from "../scripts/ops/worker-lock-guards.mjs";
// @ts-expect-error — plain .mjs ops script, no types
import { normPath, pathsOverlap, tooBroad, findConflicts, queueFull, pushTurnFree, PUSH_TURN_STALE_MS, maxWorkersAt, reexportTarget, lockAreaFor, cardContractGaps, checkCardContract, parseCardFlags, managerCard, cardFromJson, TSC_STEPS, TSC_HEAP_FLAG, tscEnv, pushPlan, pushDoneLine, waitLine, checkRedGate, failingTestNames, failingSteps, parseCiFlags, runCi, CI_DEFAULT_TIMEOUT_MIN, lastPushedSha, CI_EXIT, migrationDefines, relatedSqlTests, deployPeek, runRelatedSql, sqlTestSafe, relatedTestScript } from "../scripts/ops/worker-lock.mjs";

describe("worker locks (two workers must never build in the same files)", () => {
  it("compares paths from the app root, whatever the slashes", () => {
    expect(normPath("production\\src\\lib\\deals\\")).toBe("src/lib/deals");
    expect(normPath("./src/lib/x.ts")).toBe("src/lib/x.ts");
  });

  it("a folder overlaps the files inside it, but not a sibling with a longer name", () => {
    expect(pathsOverlap("src/lib/deals", "src/lib/deals/deal-rules.ts")).toBe(true);
    expect(pathsOverlap("src/lib/deals/deal-rules.ts", "src/lib/deals")).toBe(true);
    expect(pathsOverlap("src/lib/deal", "src/lib/deals")).toBe(false);
    expect(pathsOverlap("src/app/(app)/deals", "src/app/(app)/customers")).toBe(false);
  });

  it("refuses claims so broad they would lock every other worker out", () => {
    expect(tooBroad("src")).toBe(true);
    expect(tooBroad("src/app")).toBe(true);
    expect(tooBroad("src/lib/deals")).toBe(false);
    expect(tooBroad("scripts/ops")).toBe(true);
    expect(tooBroad(".")).toBe(true);
    expect(tooBroad("")).toBe(true);
    expect(tooBroad("*")).toBe(true);
    expect(tooBroad("src/*")).toBe(true);
    expect(tooBroad("src/lib/*.ts")).toBe(true);
    expect(tooBroad(".github")).toBe(true);
  });

  it("R-345: an exact FILE path is fine at any depth (root config files can be locked)", () => {
    expect(tooBroad("sentry.client.config.ts")).toBe(false);
    expect(tooBroad("production/next.config.ts")).toBe(false);
    expect(tooBroad("scripts/setup-cloud-scheduler.sh")).toBe(false);
    expect(tooBroad("tests/worker-lock.test.ts")).toBe(false);
    expect(tooBroad(".env.example")).toBe(false);
    expect(tooBroad("production\\package.json")).toBe(false);
  });

  it("names the other card and both paths on a conflict, and ignores its own lock", () => {
    const locks = [
      { card: "R-197", areas: ["src/app/(app)/deals"], files: [] },
      { card: "R-300", areas: ["src/lib/inbound"], files: ["src/lib/ai/app-help.ts"] },
    ];
    expect(findConflicts("R-197", ["src/app/(app)/deals/page.tsx"], locks)).toEqual([]);
    expect(findConflicts("R-301", ["src/app/(app)/deals/page.tsx"], locks)).toEqual([
      { card: "R-197", mine: "src/app/(app)/deals/page.tsx", theirs: "src/app/(app)/deals" },
    ]);
    expect(findConflicts("R-301", ["src/lib/ai/app-help.ts"], locks).map((c: { card: string }) => c.card)).toEqual(["R-300"]);
    expect(findConflicts("R-301", ["src/lib/customers"], locks)).toEqual([]);
  });

  it("lets at most 4 workers run, and a worker re-claiming its own card is not counted", () => {
    const four = ["R-1", "R-2", "R-3", "R-4"].map((card) => ({ card, areas: [], files: [] }));
    expect(queueFull("R-5", four.slice(0, 3), 4)).toBe(false);
    expect(queueFull("R-5", four, 4)).toBe(true);
    expect(queueFull("R-4", four, 4)).toBe(false);
    expect(queueFull("R-5", four, 8)).toBe(false);
  });

  it("one push at a time; a turn left by a crashed worker frees itself after 15 min", () => {
    const now = 1_000_000_000;
    expect(pushTurnFree(null, now)).toBe(true);
    expect(pushTurnFree({ card: "R-1", at: now - 60_000 }, now)).toBe(false);
    expect(pushTurnFree({ card: "R-1", at: now - PUSH_TURN_STALE_MS - 1 }, now)).toBe(true);
  });

  it("card prep: spots a page that only re-exports another (R-197's deals page)", () => {
    expect(reexportTarget('export { default } from "../leads/page";\n')).toBe("../leads/page");
    expect(reexportTarget("// deals = leads\nexport { default, metadata } from '@/app/(app)/leads/page';")).toBe("@/app/(app)/leads/page");
    expect(reexportTarget("export default function Page() { return null; }")).toBeNull();
    expect(reexportTarget('import x from "y";\nconst a = 1;\nexport { a } from "z";')).toBeNull();
  });

  it("card prep: a file's lock area is its folder; never broader than 3 parts", () => {
    expect(lockAreaFor("production/src/app/(app)/deals/page.tsx")).toBe("src/app/(app)/deals");
    expect(lockAreaFor("src/lib/nav.ts")).toBe("src/lib/nav.ts");
    expect(lockAreaFor("src/components/layout/topbar.tsx")).toBe("src/components/layout/topbar.tsx");
  });

  it("2 workers while Pardeep works (09:00–21:59 IST), 4 at night", () => {
    expect(maxWorkersAt("2026-10-07T03:30:00Z")).toBe(2); // 09:00 IST
    expect(maxWorkersAt("2026-10-07T16:29:00Z")).toBe(2); // 21:59 IST
    expect(maxWorkersAt("2026-10-07T16:30:00Z")).toBe(3); // 22:00 IST (R-1960: night cap 3)
    expect(maxWorkersAt("2026-10-06T21:00:00Z")).toBe(3); // 02:30 IST
  });
});

describe("R-842: board v76 card contract (claim/push refuse an incomplete card)", () => {
  const full = {
    id: "R-500", title: "x", kind: "bug", category: "billing", doneWhen: "invoice total right",
    triage: { verdict: "zaroori", why: "customer ko galat bill", at: "2026-10-11T07:00:00Z" },
    howToCheck: "1. /invoices kholo 2. total dekho",
  };
  const file = (card: unknown) => () => JSON.stringify(card);
  const flags = { cardPath: "card.json", noCheck: false };

  it("missing kind → claim refused, naming the field", () => {
    const { kind: _k, ...noKind } = full;
    const r = checkCardContract("R-500", "claim", flags, file(noKind));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("kind");
    expect(cardContractGaps(noKind, "claim")).toEqual(["kind"]);
  });

  it("full card → claim and push ok", () => {
    expect(checkCardContract("R-500", "claim", flags, file(full)).ok).toBe(true);
    expect(checkCardContract("R-500", "push", flags, file(full)).ok).toBe(true);
  });

  it("missing howToCheck → push refused (claim still fine)", () => {
    const { howToCheck: _h, ...noCheck } = full;
    expect(checkCardContract("R-500", "claim", flags, file(noCheck)).ok).toBe(true);
    const r = checkCardContract("R-500", "push", flags, file(noCheck));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("howToCheck");
    expect(cardContractGaps({ ...full, howToCheck: "   " }, "push")).toEqual(["howToCheck"]);
  });

  it("triage needs verdict, why AND at; blank strings count as missing", () => {
    expect(cardContractGaps({ ...full, triage: { verdict: "zaroori" } }, "claim")).toEqual(["triage.why", "triage.at"]);
    expect(cardContractGaps({ ...full, triage: undefined, category: "" }, "claim")).toEqual(["triage.verdict", "triage.why", "triage.at", "category"]);
    expect(cardContractGaps({}, "claim")).toHaveLength(6);
  });

  it("no --card → refused with how-to; --no-card-check only for R-9xx manager cards", () => {
    const none = { cardPath: null, noCheck: false };
    const r = checkCardContract("R-500", "claim", none, file(full));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("--card");
    expect(checkCardContract("R-500", "claim", { cardPath: null, noCheck: true }).ok).toBe(false);
    expect(checkCardContract("R-912", "push", { cardPath: null, noCheck: true }).ok).toBe(true);
    expect(managerCard("R-999")).toBe(true);
    expect(managerCard("R-9001")).toBe(false);
    expect(managerCard("R-842")).toBe(false);
  });

  it("refuses a card file for another card, and unreadable JSON", () => {
    expect(checkCardContract("R-501", "claim", flags, file(full)).message).toContain("R-500");
    expect(checkCardContract("R-500", "claim", flags, () => "{nope").ok).toBe(false);
  });

  it("reads the ArtifactData out_dir file and a {id, data} wrapper alike", () => {
    expect(cardFromJson({ id: "R-500", version: 3, data: full }).kind).toBe("bug");
    expect(checkCardContract("R-500", "claim", flags, file({ id: "R-500", data: full })).ok).toBe(true);
  });

  it("flags come out of the args; areas stay positional", () => {
    expect(parseCardFlags(["C:/wt", "src/lib/deals", "--card", "c.json"])).toEqual({ rest: ["C:/wt", "src/lib/deals"], cardPath: "c.json", noCheck: false });
    expect(parseCardFlags(["--card=c.json", "--no-card-check"])).toEqual({ rest: [], cardPath: "c.json", noCheck: true });
  });
});

/* R-1814 (24 Oct 2026): a worker waiting for its push turn reported "R-1813 push ho gaya: 9e4f6dfc" —
   another worker's card and commit. The success line printed `git rev-parse HEAD` after the rebase, which is
   the OTHER worker's tip when this branch adds nothing (commits already upstream / dropped by the rebase),
   and the wait line put the other card's name where a summary reads it. Now: the push is judged by the
   worker's OWN commits (anutech/manager-pardeep..HEAD), nothing → no push, and every line names its own card. */
describe("push reports its own card and its own commits (R-1814)", () => {
  it("nothing of its own after the rebase → no push, and it says so", () => {
    const r = pushPlan("R-1814", []);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/R-1814/);
    expect(r.message).toMatch(/kuch nahi/);
  });

  it("success line = own card + own newest commit sha, never the upstream tip", () => {
    const r = pushPlan("R-1814", [
      { sha: "aaaa1111", subject: "R-1814: rows open from the keyboard" },
      { sha: "bbbb2222", subject: "R-1814: raw errors" },
    ]);
    expect(r.ok).toBe(true);
    expect(r.sha).toBe("aaaa1111");
    expect(pushDoneLine("R-1814", r)).toBe("✓ R-1814 push ho gaya: aaaa1111 (2 commit apne)");
    expect(pushDoneLine("R-1814", r)).not.toMatch(/R-1813|9e4f6dfc/);
  });

  it("warns when the branch carries commits of another card", () => {
    const r = pushPlan("R-1814", [
      { sha: "aaaa1111", subject: "R-1814: mine" },
      { sha: "cccc3333", subject: "R-1813: someone else's" },
    ]);
    expect(r.ok).toBe(true);
    expect(r.foreign).toEqual(["cccc3333 R-1813: someone else's"]);
  });

  it("the wait line says the other card is someone else's and names mine", () => {
    const line = waitLine("push", "R-1814", "R-1813", "push kar raha hai");
    expect(line).toMatch(/^… R-1814:/);
    expect(line).toMatch(/doosra worker R-1813/);
    expect(line).not.toMatch(/^… R-1813/);
  });
});

/* R-1592 (18 Oct 2026): a <Link href="/wrong-page"> passed the push gate and `npm run typecheck`
   (plain tsc: no .next/types in a fresh worktree / CI checkout → href is just a string) and only
   `next build` went red. Both now run `next typegen` first, like the Cloud Build gate. */
describe("type-check sees typed routes (R-1592)", () => {
  const root = path.resolve(__dirname, "..");
  it("the push gate's tsc step generates route types first", () => {
    expect(TSC_STEPS[0]).toBe("npx next typegen");
    expect(TSC_STEPS[TSC_STEPS.length - 1]).toMatch(/^npx tsc --noEmit/);
  });
  it("npm run typecheck (CI) runs next typegen before tsc", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.typecheck).toMatch(/next typegen && tsc --noEmit/);
  });
  it("tsconfig includes the generated route types and next.config keeps typedRoutes on", () => {
    expect(readFileSync(path.join(root, "tsconfig.json"), "utf8")).toContain(".next/types/**/*.ts");
    expect(readFileSync(path.join(root, "next.config.mjs"), "utf8")).toMatch(/^\s*typedRoutes: true,/m);
  });
});

/* R-1827 (24 Oct 2026): after R-1791 tsc ran out of Node's default ~4 GB heap inside `push`/`tsc`.
   Every TSC_STEPS child now gets CI's typecheck heap through NODE_OPTIONS, merged with what is set. */
describe("tsc heap (R-1827)", () => {
  const root = path.resolve(__dirname, "..");
  it("uses the same 8 GB heap as CI's typecheck step", () => {
    expect(TSC_HEAP_FLAG).toBe("--max-old-space-size=8192");
    const ci = readFileSync(path.join(root, "..", ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toContain(`NODE_OPTIONS: ${TSC_HEAP_FLAG}`);
  });
  it("adds the heap flag when NODE_OPTIONS is unset", () => {
    expect(tscEnv({ PATH: "x" })).toEqual({ PATH: "x", NODE_OPTIONS: "--max-old-space-size=8192" });
  });
  it("keeps other NODE_OPTIONS and replaces an existing heap flag instead of doubling it", () => {
    const env = tscEnv({ NODE_OPTIONS: "--max-old-space-size=4096  --enable-source-maps" });
    expect(env.NODE_OPTIONS).toBe("--enable-source-maps --max-old-space-size=8192");
  });
  it("does not change the caller's env object", () => {
    const orig = { NODE_OPTIONS: "--trace-warnings" };
    tscEnv(orig);
    expect(orig.NODE_OPTIONS).toBe("--trace-warnings");
  });
  it("every TSC_STEPS child is spawned with tscEnv()", () => {
    const src = readFileSync(path.join(root, "scripts", "ops", "worker-lock.mjs"), "utf8");
    const at = src.indexOf("function tscWithTurn");
    const body = src.slice(at, at + 2000);
    expect(body).toMatch(/for \(const step of tscStepsFor\(\{ full \}\)\)/); // R-1960: TSC_STEPS, or the cold step with --full-tsc
    expect(body).toMatch(/sh\(step, tscEnv\(\)\)/);
  });
});

/* R-1936 (25 Oct 2026, G-PROCESS #2): CI was red 26% and SQL tests 23% of the time (12–25 Oct), with red
   stretches up to 24 h, because new pushes kept landing on a red manager-pardeep. push now refuses on red,
   `ci <CARD>` waits for the sha's runs, and a changed migration runs its related SQL tests first. gh/git/psql faked. */
type Run = { databaseId: number; workflowName: string; status: string; conclusion: string; headSha: string; url: string; createdAt: string };
const run = (o: Partial<Run>): Run => ({ databaseId: 1, workflowName: "CI", status: "completed", conclusion: "success", headSha: "a".repeat(40), url: "https://gh/run/1", createdAt: "2026-10-25T10:00:00Z", ...o });
/* Real `gh run view --log-failed` lines (run 40212296266, SQL tests, 25 Oct). */
const SQL_RED_LOG = [
  "sql-tests\tRun the SQL test suite\t2026-10-25T16:36:02.1298707Z  FAIL [21/300] audit_log_values",
  "sql-tests\tRun the SQL test suite\t2026-10-25T16:36:27.7999349Z  FAIL [239/300] r897_automation_gate",
  "sql-tests\tRun the SQL test suite\t2026-10-25T16:36:41.0354644Z 298/304 pass  4 not-applicable  2 FAIL",
  "sql-tests\tRun the SQL test suite\t2026-10-25T16:36:41.0355430Z ERROR:  FAIL 5: a system change (no user) was logged",
].join("\n");

function fakeGh(table: { branch?: Run[]; sha?: Run[] | ((n: number) => Run[]); log?: string; jobs?: unknown; fail?: boolean }) {
  const calls: string[][] = [];
  let shaCalls = 0;
  const gh = (args: string[]) => {
    calls.push(args);
    if (table.fail) throw new Error("spawn gh ENOENT");
    if (args[0] === "run" && args[1] === "list" && args.includes("--commit")) { shaCalls++; const s = table.sha; return JSON.stringify(typeof s === "function" ? s(shaCalls) : s ?? []); }
    if (args[0] === "run" && args[1] === "list") return JSON.stringify(table.branch ?? []);
    if (args[0] === "run" && args[1] === "view" && args.includes("--log-failed")) return table.log ?? "";
    if (args[0] === "run" && args[1] === "view" && args.includes("--json")) return JSON.stringify(table.jobs ?? { jobs: [] });
    throw new Error("unexpected gh " + args.join(" "));
  };
  return { gh, calls };
}

describe("R-1936: push refuses while manager-pardeep CI is red", () => {
  const redSql = run({ databaseId: 40212296266, workflowName: "SQL tests", conclusion: "failure", headSha: "958cece7c4640d0c25b73e4f4203da0aea712759", url: "https://gh/run/sql" });
  const greenCi = run({ workflowName: "CI" });

  it("red blocks, naming the workflow, the sha and the failing tests", () => {
    const { gh } = fakeGh({ branch: [greenCi, redSql], log: SQL_RED_LOG });
    const r = checkRedGate("R-2000", { gh });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("CI laal hai (SQL tests on 958cece7: audit_log_values, r897_automation_gate) — pehle woh theek karo");
    expect(r.message).toContain("--fixes-red");
    expect(r.message).toContain("https://gh/run/sql");
  });

  it("asks GitHub about manager-pardeep on Anutech-Digital/anutechbilling", () => {
    const { gh, calls } = fakeGh({ branch: [greenCi] });
    checkRedGate("R-2000", { gh });
    expect(calls[0]).toEqual(expect.arrayContaining(["run", "list", "-R", "Anutech-Digital/anutechbilling", "-b", "manager-pardeep", "--json"]));
  });

  it("--fixes-red and --owner-override pass, and each is logged", () => {
    for (const flag of ["fixesRed", "ownerOverride"] as const) {
      const logged: string[] = [];
      const { gh } = fakeGh({ branch: [redSql], log: SQL_RED_LOG });
      const r = checkRedGate("R-2000", { gh, [flag]: true, log: (l: string) => logged.push(l) });
      expect(r.ok, flag).toBe(true);
      expect(logged).toHaveLength(1);
      expect(JSON.parse(logged[0])).toMatchObject({ card: "R-2000", how: flag === "fixesRed" ? "--fixes-red" : "--owner-override" });
      expect(logged[0]).toContain("audit_log_values");
    }
  });

  it("a run still in progress does not block — even over an older red one", () => {
    const going = run({ databaseId: 9, workflowName: "SQL tests", status: "in_progress", conclusion: "", createdAt: "2026-10-25T17:00:00Z" });
    const { gh } = fakeGh({ branch: [greenCi, redSql, going] });
    const r = checkRedGate("R-2000", { gh });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("SQL tests abhi chal raha hai");
  });

  it("a cancelled (superseded) newest run is passed over — the finished red one below still blocks", () => {
    const cancelled = run({ databaseId: 9, workflowName: "SQL tests", conclusion: "cancelled", createdAt: "2026-10-25T17:00:00Z" });
    const { gh } = fakeGh({ branch: [redSql, cancelled], log: SQL_RED_LOG });
    expect(checkRedGate("R-2000", { gh }).ok).toBe(false);
  });

  it("green → go; gh missing / offline → warn and go, never blocks", () => {
    expect(checkRedGate("R-2000", { gh: fakeGh({ branch: [greenCi] }).gh }).ok).toBe(true);
    const r = checkRedGate("R-2000", { gh: fakeGh({ fail: true }).gh });
    expect(r.ok).toBe(true);
    expect(r.warn).toBe(true);
    expect(r.message).toMatch(/^⚠/);
  });

  it("no test name in the log → the failed step from the jobs list", () => {
    const jobs = { jobs: [{ name: "checks", steps: [{ name: "Run npm run lint:ratchet", conclusion: "failure" }, { name: "Build", conclusion: "success" }] }] };
    const { gh } = fakeGh({ branch: [run({ conclusion: "failure" })], log: "checks\tx\t2026-10-25T03:31:03Z ##[error]Process completed with exit code 1.", jobs });
    expect(checkRedGate("R-2000", { gh }).message).toContain("step: checks › Run npm run lint:ratchet");
  });

  it("failing test names: test-sql and vitest FAIL lines + ratchet summaries, no summary counts", () => {
    expect(failingTestNames(SQL_RED_LOG)).toEqual(["audit_log_values", "r897_automation_gate"]);
    const vitest = "checks\tTest\t2026-10-25T03:27:05.1Z \x1b[31m FAIL \x1b[39m tests/a.test.ts > money > rounds";
    expect(failingTestNames(vitest)).toEqual(["tests/a.test.ts > money > rounds"]);
    expect(failingTestNames("c\tx\t2026-10-25T03:31:03.29Z Lint ratchet FAILED — more warnings than baseline for: max-lines")).toEqual(["Lint ratchet FAILED — more warnings than baseline for: max-lines"]);
    expect(failingSteps({ jobs: [{ name: "j", steps: [{ name: "s", conclusion: "timed_out" }] }] })).toEqual(["j › s"]);
  });

  it("push wires the gate: related SQL before the turn, red gate after fetch and before git push (exit 7)", () => {
    const src = readFileSync(path.join(path.resolve(__dirname, ".."), "scripts", "ops", "worker-lock.mjs"), "utf8");
    const push = src.slice(src.indexOf("async function pushWithTurn"));
    const rel = push.indexOf("relatedSqlGate(card");
    const turn = push.indexOf('withTurn("push"');
    const fetch = push.indexOf("git fetch -q anutech");
    const gate = push.indexOf("checkRedGate(card");
    const gitPush = push.indexOf("git push -q anutech");
    expect(rel).toBeGreaterThan(0);
    expect(turn).toBeGreaterThan(rel);
    expect(gate).toBeGreaterThan(fetch);
    expect(gitPush).toBeGreaterThan(gate);
    expect(push.slice(gate, gate + 300)).toContain("process.exit(7)");
  });

  it("flags: --fixes-red, --owner-override, --sha, --timeout-min come out of the args", () => {
    expect(parseCiFlags(["--fixes-red", "--sha", "abc", "--timeout-min", "3", "x"])).toMatchObject({ rest: ["x"], fixesRed: true, ownerOverride: false, sha: "abc", timeoutMin: 3 });
    expect(parseCiFlags(["--owner-override", "--timeout-min=bad"])).toMatchObject({ ownerOverride: true, timeoutMin: 35, sha: null });
  });

  it("R-1987: ci waits 35 min by default (CI takes ~29 min; 25 timed out nearly every card), --timeout-min still overrides", () => {
    expect(CI_DEFAULT_TIMEOUT_MIN).toBe(35);
    expect(parseCiFlags([]).timeoutMin).toBe(35);
    expect(parseCiFlags(["--timeout-min", "0"]).timeoutMin).toBe(35);
    expect(parseCiFlags(["--timeout-min", "50"]).timeoutMin).toBe(50);
    const src = readFileSync(path.join(path.resolve(__dirname, ".."), "scripts", "ops", "worker-lock.mjs"), "utf8");
    expect(src).toMatch(/runCi\(card, \{[^}]*timeoutMin = CI_DEFAULT_TIMEOUT_MIN/);
    expect(src).toContain("[--timeout-min 35]");
  });
});

describe("R-1936: ci <CARD> waits for the sha's CI + SQL tests", () => {
  const SHA = "b".repeat(40);
  const git = (args: string[]) => (args[0] === "rev-parse" || args[0] === "log" ? `${SHA}\n` : "");
  const clock = () => { let t = Date.parse("2026-10-25T17:00:00Z"); return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };
  const base = (gh: (a: string[]) => string, extra = {}) => ({ gh, git, isAncestor: () => false, sha: SHA, timeoutMin: 25, ...clock(), ...extra });

  it("both green → exit 0 and the one-line JSON for ciCheck", async () => {
    const { gh } = fakeGh({ sha: [run({ headSha: SHA, url: "u-ci" }), run({ workflowName: "SQL tests", headSha: SHA, url: "u-sql" })] });
    const r = await runCi("R-2000", base(gh));
    expect(r.code).toBe(0);
    expect(r.check).toEqual({ sha: SHA, ci: "green", sql: "green", at: "2026-10-25T17:00:00Z", runUrls: ["u-ci", "u-sql"] });
    expect(r.lines.join("\n")).toContain("ciCheck");
  });

  it("waits while a run is going, then decides; no SQL run for the sha = skipped (no supabase change)", async () => {
    const going = [run({ headSha: SHA, status: "in_progress", conclusion: "" })];
    const done = [run({ headSha: SHA })];
    const { gh } = fakeGh({ sha: (n) => (n < 3 ? going : done) });
    const printed: string[] = [];
    const r = await runCi("R-2000", base(gh, { print: (l: string) => printed.push(l) }));
    expect(printed.length).toBe(2);
    expect(r.code).toBe(0);
    expect(r.check?.sql).toBe("skipped");
  });

  it("red → exit 7 with the failing test names", async () => {
    const { gh } = fakeGh({ sha: [run({ headSha: SHA }), run({ workflowName: "SQL tests", headSha: SHA, conclusion: "failure", url: "u-sql" })], log: SQL_RED_LOG });
    const r = await runCi("R-2000", base(gh));
    expect(r.code).toBe(7);
    expect(r.check).toMatchObject({ ci: "green", sql: "red", sqlFailed: ["audit_log_values", "r897_automation_gate"] });
    expect(r.lines.join("\n")).toContain("✗ SQL tests laal: audit_log_values, r897_automation_gate");
  });

  it("still running at the timeout → exit 8, JSON says pending", async () => {
    const { gh } = fakeGh({ sha: [run({ headSha: SHA, status: "in_progress", conclusion: "" })] });
    const r = await runCi("R-2000", base(gh, { timeoutMin: 2 }));
    expect(r.code).toBe(8);
    expect(r.check?.ci).toBe("pending");
  });

  it("gh never answers → exit 8, no JSON", async () => {
    const r = await runCi("R-2000", base(fakeGh({ fail: true }).gh, { timeoutMin: 1 }));
    expect(r.code).toBe(8);
    expect(r.check).toBeNull();
  });

  it("own run cancelled by the next push → the newer run that contains this sha decides", async () => {
    const later = "c".repeat(40);
    const { gh } = fakeGh({
      sha: [run({ databaseId: 1, headSha: SHA, conclusion: "cancelled" })],
      branch: [run({ databaseId: 2, headSha: later, url: "u-later", createdAt: "2026-10-25T17:05:00Z" })],
    });
    const r = await runCi("R-2000", base(gh, { isAncestor: (a: string, b: string) => a === SHA && b === later }));
    expect(r.code).toBe(0);
    expect(r.check).toMatchObject({ ci: "green", via: later, runUrls: ["u-later"] });
  });

  it("default sha: the note push wrote, else the newest '<CARD>:' commit on manager-pardeep", () => {
    expect(lastPushedSha("R-2000", { git, readNote: () => ({ sha: "f00" }) })).toBe("f00");
    const asked: string[][] = [];
    const g = (a: string[]) => { asked.push(a); return `${SHA}\n`; };
    expect(lastPushedSha("r-2000", { git: g, readNote: () => null })).toBe(SHA);
    expect(asked[0]).toEqual(["log", "anutech/manager-pardeep", "-1", "--format=%H", "-E", "--grep=^R-2000:"]);
  });

  it("exit codes are 0 green, 7 red, 8 timeout", () => {
    expect(CI_EXIT).toEqual({ green: 0, red: 7, timeout: 8 });
  });
});

describe("R-1936: a changed migration runs its related SQL tests on the local DB first", () => {
  const MIG = { file: "20261026000000_r2000_x.sql", src: "-- deploy-peek: exists(select 1 from pg_proc where proname = 'book_expense')\nbegin;\ncreate or replace function public.book_expense(p uuid) returns void language plpgsql as $$ begin null; end $$;\ncreate table if not exists public.vendor_notes (id uuid);\ncommit;\n" };
  const T = (file: string, body: string) => ({ file, src: `begin;\n${body}\nrollback;\n` });
  const tests = [T("book_expense.test.sql", "select public.book_expense(null);"), T("vendor.test.sql", "select * from vendor_notes;"), T("other.test.sql", "select book_expenses_total();")];

  it("names what the migration creates: functions, tables, views (no schema, lower case)", () => {
    expect(migrationDefines(MIG.src).sort()).toEqual(["book_expense", "vendor_notes"]);
    expect(migrationDefines('CREATE OR REPLACE VIEW "public"."V_Due" AS select 1; -- create table not_this')).toEqual(["v_due"]);
  });

  it("picks the tests that mention a name as a whole word only", () => {
    expect(relatedSqlTests(["book_expense", "vendor_notes"], tests).map((t: { file: string }) => t.file)).toEqual(["book_expense.test.sql", "vendor.test.sql"]);
    expect(deployPeek(MIG.src)).toBe("exists(select 1 from pg_proc where proname = 'book_expense')");
  });

  it("runs migration + test in one rolled-back transaction; a red test fails the push", () => {
    const sent: string[] = [];
    const psql = (sql: string) => {
      sent.push(sql);
      if (sql.includes("PEEK_APPLIED")) return { status: 0, out: "PEEK_PENDING\n" };
      /* red only WITH the new migration — green on the local DB without it: this push broke it */
      return sql.includes("vendor_notes;") && sql.includes("create table if not exists public.vendor_notes") ? { status: 3, out: 'ERROR:  relation "vendor_notes" broke' } : { status: 0, out: "" };
    };
    const r = runRelatedSql({ changed: [MIG], tests, psql });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('✗ vendor.test.sql: ERROR:  relation "vendor_notes" broke');
    const script = sent.find((s) => s.includes("book_expense(null)"))!;
    expect(script.startsWith("begin;\n")).toBe(true);
    expect(script).toContain("create or replace function public.book_expense");
    expect(script).not.toMatch(/^\s*commit\s*;/im); // the migration's own commit never reaches the DB
    expect(script.trimEnd().endsWith("rollback;")).toBe(true);
  });

  it("red with AND without the migration = the local DB was already broken → warn, not block", () => {
    /* 25 Oct, real: merge_stranded_user.test.sql fails on the local DB alone (a leftover tenants row). */
    const psql = (sql: string) => (sql.includes("PEEK_APPLIED") ? { status: 0, out: "PEEK_PENDING" } : sql.includes("vendor_notes;") ? { status: 3, out: "ERROR:  duplicate key value violates unique constraint \"tenants_pkey\"" } : { status: 0, out: "" });
    const r = runRelatedSql({ changed: [MIG], tests, psql });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("⚠ vendor.test.sql: migration ke bina bhi local DB par laal");
  });

  it("a migration already on the local DB (deploy-peek true) is not run again", () => {
    const sent: string[] = [];
    const psql = (sql: string) => { sent.push(sql); return sql.includes("PEEK_APPLIED") ? { status: 0, out: "PEEK_APPLIED\n" } : { status: 0, out: "" }; };
    const r = runRelatedSql({ changed: [MIG], tests, psql });
    expect(r.ok).toBe(true);
    expect(sent.filter((s) => s.includes("create or replace function"))).toHaveLength(0);
  });

  it("local DB down → warn and skip; no migration change → nothing to run", () => {
    const down = runRelatedSql({ changed: [MIG], tests, psql: null });
    expect(down).toMatchObject({ ok: true, skipped: true });
    expect(down.message).toMatch(/^⚠ local DB nahi chal raha/);
    expect(runRelatedSql({ changed: [], tests, psql: () => ({ status: 1, out: "" }) })).toMatchObject({ ok: true, skipped: true });
  });

  it("a related test that does not end in rollback fails (CI's runner refuses it too)", () => {
    const r = runRelatedSql({ changed: [MIG], tests: [{ file: "bad.test.sql", src: "select book_expense(null);\ncommit;" }], psql: () => ({ status: 0, out: "PEEK_APPLIED" }) });
    expect(r.ok).toBe(false);
    expect(sqlTestSafe("begin;\nrollback;")).toBe(true);
  });

  it("CONCURRENTLY cannot run in a transaction → skip with a warning, never a false red", () => {
    const m = { file: "m.sql", src: "create index concurrently if not exists i on public.vendor_notes(id);\ncreate table if not exists public.vendor_notes (id uuid);" };
    expect(runRelatedSql({ changed: [m], tests, psql: () => ({ status: 1, out: "" }) })).toMatchObject({ ok: true, skipped: true });
    expect(relatedTestScript([], "begin;\nrollback;")).toBe("begin;\n\n\nbegin;\nrollback;\n");
  });
});

/* ───────── R-2106 (31 Oct 2026) ───────── */

describe("R-2106: push runs CI's migration-order check before pushing", () => {
  it("a red check refuses with the script's own problem lines; green passes", () => {
    const red = migrationOrderGate(() => ({ status: 1, out: "base x\n\nMigration check FAILED:\n  edited an existing migration: 20261030131008_a.sql — it has likely run already\n" }));
    expect(red.ok).toBe(false);
    expect(red.message).toMatch(/edited an existing migration: 20261030131008_a\.sql/);
    expect(red.message).toMatch(/-- deploy-/);
    expect(migrationOrderGate(() => ({ status: 0, out: "migrations OK" })).ok).toBe(true);
  });

  it("asks the check with base anutech/manager-pardeep (what CI's github.event.before is after the rebase)", () => {
    let seen: string[] = [];
    migrationOrderGate((args: string[]) => { seen = args; return { status: 0, out: "" }; });
    expect(seen).toEqual(["scripts/migration-order-check.mjs", "--base", "anutech/manager-pardeep"]);
  });

  it("push calls it after the rebase and before tsc / guard suites / the git push", () => {
    const src = readFileSync(path.join(__dirname, "..", "scripts", "ops", "worker-lock.mjs"), "utf8");
    const body = src.slice(src.indexOf("async function pushWithTurn"));
    const at = (s: string) => body.indexOf(s);
    expect(at("realMigrationOrderGate(")).toBeGreaterThan(at("rebaseResolvingDerived("));
    expect(at("realMigrationOrderGate(")).toBeLessThan(at("tscWithTurn("));
    expect(at("realMigrationOrderGate(")).toBeLessThan(at("git push -q anutech"));
  });

  it("the real script on a throwaway repo: a non-header edit of an existing migration is red, a header-only edit green", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r2106-mo-"));
    try {
      const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
      const g = (...a: string[]) => execFileSync("git", a, { cwd: tmp, env, stdio: ["ignore", "pipe", "pipe"] });
      fs.mkdirSync(path.join(tmp, "production", "scripts"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "production", "supabase", "migrations"), { recursive: true });
      fs.copyFileSync(path.join(__dirname, "..", "scripts", "migration-order-check.mjs"), path.join(tmp, "production", "scripts", "migration-order-check.mjs"));
      const mig = path.join(tmp, "production", "supabase", "migrations", "20261030131008_a.sql");
      fs.writeFileSync(mig, "-- deploy-peek: true\nselect 1;\n");
      g("init", "-q", "-b", "main"); g("add", "-A"); g("commit", "-q", "-m", "base"); g("branch", "base");
      const run = (args: string[]) => { const r = spawnSync(process.execPath, args, { cwd: path.join(tmp, "production"), encoding: "utf8" }); return { status: r.status, out: `${r.stdout}${r.stderr}` }; };

      fs.writeFileSync(mig, "-- deploy-peek: to_regclass('public.a') is not null\nselect 1;\n");
      g("commit", "-qam", "header only");
      expect(migrationOrderGate(run, "base").ok).toBe(true);

      fs.writeFileSync(mig, "-- deploy-peek: to_regclass('public.a') is not null\n-- a note\nselect 1;\n");
      g("commit", "-qam", "comment line");
      const r = migrationOrderGate(run, "base");
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/edited an existing migration: 20261030131008_a\.sql/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe("R-2106: claim paths are normalised (29 Oct: R-2102/R-2104/R-2098 own files refused at push)", () => {
  it("splits comma-joined strings, strips production/ and the worktree's absolute path, dedupes", () => {
    const wt = "C:/Users/me/reselleros-w-r-1";
    expect(normaliseClaimAreas([
      "production/src/lib/deals,src/lib/deals/x.ts, src/app/(app)/leads",
      String.raw`C:\Users\me\reselleros-w-r-1\production\src\lib\quotes`,
      `${wt}/docs/WORKER-STEPS.md`,
      "src/lib/deals",
    ], wt)).toEqual(["src/lib/deals", "src/lib/deals/x.ts", "src/app/(app)/leads", "src/lib/quotes", "../docs/WORKER-STEPS.md"]);
  });
  it("leaves plain paths alone", () => {
    expect(normaliseClaimAreas(["src/lib/x.ts", "../docs/A.md"], "C:/w")).toEqual(["src/lib/x.ts", "../docs/A.md"]);
  });
});
