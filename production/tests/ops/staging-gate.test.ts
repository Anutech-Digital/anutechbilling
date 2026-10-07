import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs ops script, no types
import { parseArgs, parseRuns, ciDecision, LOCAL_STEPS, summarize } from "../../scripts/ops/staging-gate.mjs";

/* R-332 (7 Oct 2026): staging/live merges never looked at GitHub CI, and the Cloud Build gate
   skips lint. The staging gate refuses a SHA unless CI on that exact SHA finished green. */

const SHA = "6fad1f61a2b3c4d5e6f708192a3b4c5d6e7f8091";
const run = (status: string, conclusion: string) => ({ status, conclusion });

describe("staging gate — args", () => {
  it("defaults to HEAD of anutech/manager-pardeep, CI only", () => {
    expect(parseArgs([])).toEqual({ sha: null, local: false, help: false });
  });

  it("takes a SHA and --local in any order", () => {
    expect(parseArgs(["--local", SHA])).toEqual({ sha: SHA, local: true, help: false });
    expect(parseArgs([SHA, "--local"])).toEqual({ sha: SHA, local: true, help: false });
  });

  it("rejects something that is not a SHA or a known flag", () => {
    expect(() => parseArgs(["main"])).toThrow(/SHA/);
    expect(() => parseArgs(["--fast"])).toThrow(/--fast/);
  });
});

describe("staging gate — gh JSON parsing", () => {
  it("parses gh run list output", () => {
    expect(parseRuns('[{"conclusion":"success","status":"completed"}]')).toEqual([run("completed", "success")]);
  });

  it("empty output means no runs", () => {
    expect(parseRuns("")).toEqual([]);
    expect(parseRuns("  \n")).toEqual([]);
  });

  it("garbage output throws instead of passing", () => {
    expect(() => parseRuns("gh: not logged in")).toThrow();
    expect(() => parseRuns('{"conclusion":"success"}')).toThrow();
  });
});

describe("staging gate — CI decision (red CI must refuse)", () => {
  it("green: newest run completed + success", () => {
    const d = ciDecision([run("completed", "success")], SHA);
    expect(d.ok).toBe(true);
    expect(d.message).toContain("6fad1f61");
  });

  it("red: completed + failure refuses", () => {
    const d = ciDecision([run("completed", "failure")], SHA);
    expect(d.ok).toBe(false);
    expect(d.message).toMatch(/failure/);
    expect(d.message).toMatch(/mat karo|do not merge/i);
  });

  it("cancelled / skipped / timed_out refuse too", () => {
    for (const c of ["cancelled", "skipped", "timed_out", "action_required", ""]) {
      expect(ciDecision([run("completed", c)], SHA).ok).toBe(false);
    }
  });

  it("still running refuses with a wait message", () => {
    const d = ciDecision([run("in_progress", "")], SHA);
    expect(d.ok).toBe(false);
    expect(d.message).toMatch(/chal raha|still running/i);
    expect(ciDecision([run("queued", "")], SHA).ok).toBe(false);
  });

  it("no CI run for the SHA refuses (never pushed / CI did not trigger)", () => {
    const d = ciDecision([], SHA);
    expect(d.ok).toBe(false);
    expect(d.message).toMatch(/nahi mila|no CI run/i);
  });

  it("judges the NEWEST run only — an old green run does not hide a newer red re-run", () => {
    expect(ciDecision([run("completed", "failure"), run("completed", "success")], SHA).ok).toBe(false);
    expect(ciDecision([run("completed", "success"), run("completed", "failure")], SHA).ok).toBe(true);
  });
});

describe("staging gate — local gate", () => {
  it("runs the full gate one after another: vitest, lint, lint:ratchet, next build", () => {
    expect(LOCAL_STEPS.map((s: { name: string }) => s.name)).toEqual(["vitest", "lint", "lint:ratchet", "build"]);
  });

  it("summary names every failed step and says refuse", () => {
    const s = summarize(SHA, { ok: true, message: "CI hara" }, [
      { name: "vitest", ok: true, secs: 30 },
      { name: "lint", ok: false, secs: 4 },
    ]);
    expect(s.ok).toBe(false);
    expect(s.text).toContain("lint");
    expect(s.text).toMatch(/MANA|REFUSED/);
  });

  it("summary is green only when CI and every local step are green", () => {
    const s = summarize(SHA, { ok: true, message: "CI hara" }, [{ name: "vitest", ok: true, secs: 30 }]);
    expect(s.ok).toBe(true);
    expect(s.text).toMatch(/OK/);
    expect(summarize(SHA, { ok: false, message: "CI laal" }, []).ok).toBe(false);
  });
});
