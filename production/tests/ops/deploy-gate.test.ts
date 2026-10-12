import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs ops script, no types
import { parseArgs, decide, overridePhrase, parseRuns, checkPushed, runGate, overrideLogLine } from "../../scripts/ops/deploy-gate.mjs";

/* R-884 (12 Oct 2026): deploy.sh ran `gcloud run deploy --source .` from any laptop — no CI,
   wrong build args. The gate refuses unless the tree is clean, the exact sha is pushed to
   anutech, and CI + SQL tests are green on it. Emergency override needs a typed phrase. */

const SHA = "6fad1f61a2b3c4d5e6f708192a3b4c5d6e7f8091";
const green = [
  { workflowName: "CI", status: "completed", conclusion: "success" },
  { workflowName: "SQL tests", status: "completed", conclusion: "success" },
];
const base = { sha: SHA, porcelain: "", remoteBranches: "  anutech/manager-pardeep\n  origin/x", runs: green };

type Facts = { porcelain?: string; remoteBranches?: string; runs?: unknown[] };

/** Mocked git/gh — no network, no real repo. */
function deps(f: Facts = {}, typed = "") {
  const calls: string[][] = [];
  const logs: string[] = [];
  const appended: string[] = [];
  return {
    calls,
    logs,
    appended,
    exec: (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === "git" && args[0] === "rev-parse") return SHA + "\n";
      if (cmd === "git" && args[0] === "status") return f.porcelain ?? "";
      if (cmd === "git" && args[0] === "branch") return f.remoteBranches ?? base.remoteBranches;
      if (cmd === "gh") return JSON.stringify(f.runs ?? green);
      return "";
    },
    ask: async () => typed,
    log: (l: string) => logs.push(l),
    appendLog: (t: string) => appended.push(t),
  };
}

describe("deploy gate — args", () => {
  it("defaults to HEAD, real deploy", () => {
    expect(parseArgs([])).toEqual({ sha: null, dryRun: false, emergency: false, help: false });
  });
  it("takes sha, --dry-run, --emergency in any order", () => {
    expect(parseArgs(["--emergency", SHA, "--dry-run"])).toEqual({ sha: SHA, dryRun: true, emergency: true, help: false });
  });
  it("rejects unknown flags and non-shas", () => {
    expect(() => parseArgs(["--force"])).toThrow(/--force/);
    expect(() => parseArgs(["main"])).toThrow(/SHA/);
  });
});

describe("deploy gate — decision", () => {
  it("green, pushed, clean → ok", () => {
    expect(decide(base).ok).toBe(true);
  });

  it("red CI → refused", () => {
    const v = decide({ ...base, runs: [{ workflowName: "CI", status: "completed", conclusion: "failure" }, green[1]] });
    expect(v.ok).toBe(false);
    expect(v.lines.join("\n")).toMatch(/CI: red/);
  });

  it("SQL tests missing or still running → refused", () => {
    expect(decide({ ...base, runs: [green[0]] }).ok).toBe(false);
    expect(decide({ ...base, runs: [green[0], { workflowName: "SQL tests", status: "in_progress", conclusion: "" }] }).ok).toBe(false);
  });

  it("only the newest run per workflow counts (red re-run beats older green)", () => {
    const runs = [{ workflowName: "CI", status: "completed", conclusion: "failure" }, ...green];
    expect(decide({ ...base, runs }).ok).toBe(false);
  });

  it("unpushed sha → refused", () => {
    const v = decide({ ...base, remoteBranches: "  origin/manager-pardeep" });
    expect(v.ok).toBe(false);
    expect(v.lines.join("\n")).toMatch(/not pushed to anutech/);
  });

  it("anutech/HEAD -> alias line alone does not count as pushed", () => {
    expect(checkPushed("  anutech/HEAD -> anutech/main", SHA).ok).toBe(false);
  });

  it("dirty tree → refused", () => {
    const v = decide({ ...base, porcelain: " M src/app/page.tsx\n" });
    expect(v.ok).toBe(false);
    expect(v.lines.join("\n")).toMatch(/dirty/);
  });

  it("emergency cannot skip a dirty or unpushed sha", () => {
    const typed = overridePhrase(SHA);
    expect(decide({ ...base, porcelain: "?? x", emergency: true, typed }).ok).toBe(false);
    expect(decide({ ...base, remoteBranches: "", emergency: true, typed }).ok).toBe(false);
  });

  it("emergency + red CI asks for the phrase; wrong phrase refused; exact phrase overrides", () => {
    const red = { ...base, runs: [], emergency: true };
    expect(decide(red).needsPhrase).toBe(true);
    expect(decide({ ...red, typed: "yes" }).ok).toBe(false);
    const v = decide({ ...red, typed: `  ${overridePhrase(SHA)} ` });
    expect(v).toMatchObject({ ok: true, overridden: true });
  });

  it("parses gh run list JSON", () => {
    expect(parseRuns('[{"workflowName":"CI","status":"completed","conclusion":"success"}]')).toEqual([green[0]]);
    expect(parseRuns("")).toEqual([]);
  });
});

describe("deploy gate — runGate with mocked git/gh", () => {
  it("green dry-run → ok, says nothing pushed, never pushes or calls gcloud", async () => {
    const d = deps();
    const v = await runGate({ sha: SHA, dryRun: true, emergency: false }, d);
    expect(v.ok).toBe(true);
    expect(d.logs.join("\n")).toMatch(/dry-run.*would ship/);
    expect(d.calls.some((c) => c[0] === "gcloud" || c.includes("push"))).toBe(false);
    const gh = d.calls.find((c) => c[0] === "gh")!;
    expect(gh).toEqual(expect.arrayContaining(["-R", "Anutech-Digital/anutechbilling", "--commit", SHA]));
  });

  it("red sha → refused", async () => {
    const d = deps({ runs: [{ workflowName: "CI", status: "completed", conclusion: "failure" }, green[1]] });
    expect((await runGate({ sha: SHA, dryRun: true, emergency: false }, d)).ok).toBe(false);
  });

  it("emergency with the right phrase → ok and logged; wrong phrase → refused, not logged", async () => {
    const good = deps({ runs: [] }, overridePhrase(SHA));
    expect((await runGate({ sha: SHA, dryRun: false, emergency: true }, good)).ok).toBe(true);
    expect(good.appended).toHaveLength(1);
    expect(JSON.parse(good.appended[0])).toMatchObject({ sha: SHA });

    const bad = deps({ runs: [] }, "deploy it");
    expect((await runGate({ sha: SHA, dryRun: false, emergency: true }, bad)).ok).toBe(false);
    expect(bad.appended).toHaveLength(0);
  });

  it("override log line is one JSON line with the failed checks", () => {
    const line = overrideLogLine({ sha: SHA, lines: ["✓ a", "✗ CI: red"], now: new Date("2026-10-12T00:00:00Z"), user: "u" });
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({ at: "2026-10-12T00:00:00.000Z", user: "u", sha: SHA, failed: ["✗ CI: red"] });
  });
});
