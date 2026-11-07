import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs ops script, no types
import { ciWaitVerdict, ciAllReport, runCi, pushAgeMs, CI_NO_RUN_GRACE_MS, LOCK_STATES } from "../scripts/ops/worker-lock.mjs";

/*
 * R-2561 (7 Nov 2026): R-1427 was pushed 11:58Z (sha 691d8f63c); its CI ran 11:58–12:07Z. At 12:02Z
 * `worker-lock ci-all` printed ci:"unknown" and the manager's watcher stopped early. Now:
 *   run found but queued / in_progress            → "pending"
 *   no run listed yet, or gh fails, push < 15 min  → "pending"
 *   no run for the sha nor a later manager-pardeep run containing it, push 15+ min old → "unknown"
 *   green / red as before (green frees the lock, red → ci-red — R-2552 unchanged).
 */
type Run = { databaseId: number; workflowName: string; status: string; conclusion: string; headSha: string; url: string; createdAt: string };
const SHA = "691d8f63c3196325b50b10e267aed3ea8d8bb4bc";
const LATER = "f".repeat(40);
const PUSHED = "2026-11-07T11:58:32Z";
const at = (min: number) => Date.parse(PUSHED) + min * 60_000;
const run = (o: Partial<Run>): Run => ({ databaseId: 1, workflowName: "CI", status: "completed", conclusion: "success", headSha: SHA, url: "u/1", createdAt: "2026-11-07T11:58:33Z", ...o });
const lock = { card: "R-1427", areas: ["src/x"], files: [], state: LOCK_STATES.ciWait, pushedSha: SHA, ciWaitSince: PUSHED };
const gh = (shaRuns: Run[], branchRuns: Run[] = []) => (args: string[]) => JSON.stringify(args.includes("--commit") ? shaRuns : branchRuns);
const noAncestor = () => false;

describe("R-2561: ci-all says pending while CI is running or not listed yet", () => {
  it("R-1427's case: CI in_progress 4 min after the push → pending (not unknown)", () => {
    expect(ciWaitVerdict(lock, { gh: gh([run({ status: "in_progress", conclusion: "" })]), isAncestor: noAncestor, now: at(4) })).toBe("pending");
  });

  it("a queued run → pending, also long after the push", () => {
    expect(ciWaitVerdict(lock, { gh: gh([run({ status: "queued", conclusion: "" })]), isAncestor: noAncestor, now: at(40) })).toBe("pending");
  });

  it("gh lists no run yet for a just-pushed sha → pending", () => {
    expect(ciWaitVerdict(lock, { gh: gh([]), isAncestor: noAncestor, now: at(1) })).toBe("pending");
    expect(ciWaitVerdict(lock, { gh: gh([]), isAncestor: noAncestor, now: at(14.9) })).toBe("pending");
  });

  it("no run for the sha and none later containing it, push 15+ min old → unknown", () => {
    expect(ciWaitVerdict(lock, { gh: gh([]), isAncestor: noAncestor, now: at(15) })).toBe("unknown");
    expect(ciWaitVerdict(lock, { gh: gh([], [run({ databaseId: 9, headSha: LATER })]), isAncestor: noAncestor, now: at(30) })).toBe("unknown");
  });

  it("no own run but a later manager-pardeep run containing the sha, push 15+ min old → that run decides", () => {
    const contains = (a: string, b: string) => a === SHA && b === LATER;
    expect(ciWaitVerdict(lock, { gh: gh([], [run({ databaseId: 9, headSha: LATER, status: "in_progress", conclusion: "" })]), isAncestor: contains, now: at(20) })).toBe("pending");
    expect(ciWaitVerdict(lock, { gh: gh([], [run({ databaseId: 9, headSha: LATER })]), isAncestor: contains, now: at(20) })).toBe("green");
    expect(ciWaitVerdict(lock, { gh: gh([], [run({ databaseId: 9, headSha: LATER, conclusion: "failure" })]), isAncestor: contains, now: at(20) })).toBe("red");
  });

  it("green and red stay green and red (CI done, no SQL run = skipped)", () => {
    expect(ciWaitVerdict(lock, { gh: gh([run({})]), isAncestor: noAncestor, now: at(9) })).toBe("green");
    expect(ciWaitVerdict(lock, { gh: gh([run({ conclusion: "failure" })]), isAncestor: noAncestor, now: at(9) })).toBe("red");
    expect(ciWaitVerdict(lock, { gh: gh([run({}), run({ databaseId: 2, workflowName: "SQL tests", status: "in_progress", conclusion: "" })]), isAncestor: noAncestor, now: at(9) })).toBe("pending");
  });

  it("gh fails once → asked again; fails twice → pending for a young push, null (unknown) for an old one", () => {
    let calls = 0;
    const flaky = (args: string[]) => { calls++; if (calls === 1) throw new Error("HTTP 502"); return gh([run({ status: "in_progress", conclusion: "" })])(args); };
    expect(ciWaitVerdict(lock, { gh: flaky, isAncestor: noAncestor, now: at(4) })).toBe("pending");
    expect(calls).toBe(3);
    const down = () => { throw new Error("offline"); };
    expect(ciWaitVerdict(lock, { gh: down, isAncestor: noAncestor, now: at(4) })).toBe("pending");
    expect(ciWaitVerdict(lock, { gh: down, isAncestor: noAncestor, now: at(20) })).toBe(null);
  });

  it("push age comes from ciWaitSince (or pushedAt); no push time = old", () => {
    expect(pushAgeMs(lock, at(5))).toBe(5 * 60_000);
    expect(pushAgeMs({ pushedAt: PUSHED }, at(2))).toBe(2 * 60_000);
    expect(pushAgeMs({}, at(2))).toBe(Infinity);
    expect(CI_NO_RUN_GRACE_MS).toBe(15 * 60_000);
  });

  it("ci-all end to end: running → pending line + JSON, lock not settled; green → settled", () => {
    const settled: [string, number][] = [];
    const locks = [lock, { ...lock, card: "R-2", pushedSha: LATER }];
    const runs: Record<string, Run[]> = { [SHA]: [run({ status: "in_progress", conclusion: "" })], [LATER]: [run({ headSha: LATER })] };
    const g = (args: string[]) => { const i = args.indexOf("--commit"); return JSON.stringify(i >= 0 ? runs[args[i + 1]] : []); };
    const r = ciAllReport(locks, { verdict: (l: typeof lock) => ciWaitVerdict(l, { gh: g, isAncestor: noAncestor, now: at(4) }), settle: (c: string, code: number) => settled.push([c, code]), at: "2026-11-07T12:02:00Z" });
    expect(r.results.map((x: { ci: string }) => x.ci)).toEqual(["pending", "green"]);
    expect(settled).toEqual([["R-2", 0]]);
    expect(r.lines.join("\n")).toContain("R-1427  691d8f63c  CI abhi chal raha");
  });
});

describe("R-2561: ci <CARD> keeps waiting while GitHub has not listed the run (15 min from the push)", () => {
  const git = (args: string[]) => (args[0] === "rev-parse" ? `${SHA}\n` : "");
  const clock = (start: number) => { let t = start; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };

  it("no run for 4 min after the push, then CI runs and goes green → exit 0 (the old 3-min grace stopped early)", async () => {
    let n = 0;
    const g = (args: string[]) => {
      if (!args.includes("--commit")) return "[]";
      n++;
      return JSON.stringify(n <= 8 ? [] : n <= 12 ? [run({ status: "in_progress", conclusion: "" })] : [run({})]);
    };
    const r = await runCi("R-1427", { gh: g, git, isAncestor: noAncestor, sha: SHA, timeoutMin: 35, readNote: () => ({ sha: SHA, at: PUSHED }), ...clock(at(0.5)) });
    expect(r.code).toBe(0);
    expect(r.check).toMatchObject({ ci: "green", sql: "skipped" });
  });

  it("`ci` started 20 min after the push and still no run → exit 8 with ci: unknown (not 'missing')", async () => {
    const r = await runCi("R-1427", { gh: gh([]), git, isAncestor: noAncestor, sha: SHA, timeoutMin: 35, readNote: () => ({ sha: SHA, at: PUSHED }), ...clock(at(20)) });
    expect(r.code).toBe(8);
    expect(r.check).toMatchObject({ ci: "unknown" });
  });

  it("a push note for another sha is ignored: grace counts from when `ci` started", async () => {
    const r = await runCi("R-1427", { gh: gh([]), git, isAncestor: noAncestor, sha: SHA, timeoutMin: 2, readNote: () => ({ sha: LATER, at: PUSHED }), ...clock(at(20)) });
    expect(r.code).toBe(8);
    expect(r.check).toMatchObject({ ci: "pending" });
  });
});

describe("R-2561 review: a finished later run still decides for a young push", () => {
  it("no own run listed yet, a later manager-pardeep run containing the sha is green 8 min after the push → green", () => {
    const contains = (a: string, b: string) => a === SHA && b === LATER;
    expect(ciWaitVerdict(lock, { gh: gh([], [run({ databaseId: 9, headSha: LATER })]), isAncestor: contains, now: at(8) })).toBe("green");
  });

  it("ci prints 'unknown' in its line too, not 'missing'", async () => {
    let t = at(20);
    const r = await runCi("R-1427", { gh: gh([]), git: () => `${SHA}\n`, isAncestor: noAncestor, sha: SHA, timeoutMin: 35, readNote: () => ({ sha: SHA, at: PUSHED }), now: () => t, sleep: async (ms: number) => { t += ms; } });
    expect(r.lines[0]).toContain("CI … unknown");
    expect(r.lines.join("\n")).not.toContain("missing");
  });
});
