import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
// @ts-expect-error — plain .mjs ops script, no types
import { hostRefusal, parseCards, allCards, stepsFromReport, verdict, browserCheckFor } from "../../scripts/ops/card-tests.mjs";

// R-2550 (7 Nov 2026): card tests run on localhost only — never staging or live.
const script = path.resolve(__dirname, "../../scripts/ops/card-tests.mjs");

describe("card-tests host refusal (R-2550)", () => {
  it("allows only localhost, 127.0.0.1 and [::1]", () => {
    for (const ok of ["http://localhost:3001", "http://127.0.0.1:3001", "http://[::1]:3001", "https://localhost:8443/"]) {
      expect(hostRefusal(ok), ok).toBeNull();
    }
  });

  it("refuses staging, Cloud Run, anutech.in and any other host with a clear message", () => {
    expect(hostRefusal("https://resellersos-staging-njvk4nxhdq-as.a.run.app")).toMatch(/localhost.*staging/);
    expect(hostRefusal("https://billing-abc-as.a.run.app")).toMatch(/Cloud Run/);
    expect(hostRefusal("https://app.anutech.in")).toMatch(/live Anutech/);
    expect(hostRefusal("https://anutech.in")).toMatch(/live Anutech/);
    expect(hostRefusal("https://example.com")).toMatch(/not localhost/);
    // A local-looking name on another domain is still refused.
    expect(hostRefusal("http://localhost.anutech.in:3001")).toMatch(/Refused/);
    expect(hostRefusal("ftp://localhost")).toMatch(/http/);
    expect(hostRefusal("staging.example")).toMatch(/not a URL/);
  });

  it("the script itself exits 2 on a staging BASE_URL before running anything", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "card-tests-"));
    const r = spawnSync(process.execPath, [script, "R-1001"], {
      encoding: "utf8",
      env: { ...process.env, BASE_URL: "https://resellersos-staging-njvk4nxhdq-as.a.run.app", CARD_TESTS_OUT: out },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/ONLY on localhost/);
    expect(fs.readdirSync(out)).toEqual([]);
  });
});

describe("card-tests parsing and results", () => {
  it("takes only R-<digits> card ids", () => {
    expect(parseCards(["R-1001", "R-22"])).toEqual(["R-1001", "R-22"]);
    expect(() => parseCards(["R-1001; rm"])).toThrow(/card id/);
  });

  it("finds the R-1001 card spec", () => {
    expect(allCards()).toContain("R-1001");
  });

  it("turns a Playwright JSON report into steps, a verdict and a browserCheck", () => {
    const report = {
      suites: [{ title: "R-1001.spec.ts", specs: [], suites: [{ title: "d", specs: [
        { title: "Step 1: owner", tests: [{ status: "expected", annotations: [{ type: "note", description: "4 employees" }], results: [{ status: "passed", duration: 2340 }] }] },
        { title: "Step 2: sales", tests: [{ status: "unexpected", annotations: [], results: [{ status: "failed", duration: 1000, error: { message: "\u001b[31mexpected 1\u001b[39m\nmore" } }] }] },
        { title: "Step 4: kiosk", tests: [{ status: "skipped", annotations: [{ type: "skip", description: "camera" }], results: [{ status: "skipped", duration: 0 }] }] },
      ] }] }],
    };
    const steps = stepsFromReport(report);
    expect(steps.map((s: { status: string }) => s.status)).toEqual(["passed", "failed", "skipped"]);
    expect(steps[0]).toMatchObject({ seconds: 2.3, notes: ["note: 4 employees"] });
    expect(steps[1].error).toBe("expected 1 | more");
    expect(verdict(steps)).toBe("fail");
    expect(verdict([steps[0], steps[2]])).toBe("pass");
    expect(verdict([steps[2]])).toBe("not-run");
    // A spec that fails to load has no steps — that is a fail, never a quiet "not-run".
    expect(verdict([], ["SyntaxError in R-1001.spec.ts"])).toBe("fail");
    // A step that never ran (run stopped) is a failure, not a "machine can't" skip.
    const stopped = stepsFromReport({ suites: [{ specs: [{ title: "Step 9: x", tests: [{ status: "skipped", results: [] }] }] }] });
    expect(stopped[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/did not run/) });
    const bc = browserCheckFor({ card: "R-1001", baseUrl: "http://localhost:3001", finishedAt: "2026-11-07T09:00:00Z", seconds: 40, result: "fail", steps });
    expect(bc).toMatchObject({ env: "local", by: "card-test", at: "2026-11-07T09:00:00Z", result: "fail" });
    expect(bc.note).toMatch(/1 ✓ · 1 ✗ · 1 skip in 40s.*failed: Step 2.*skipped.*Step 4/);
  });
});
