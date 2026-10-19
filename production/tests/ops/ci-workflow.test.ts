import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error — js-yaml ships no types (it is installed via eslint, already in the lockfile)
import yaml from "js-yaml";

/* R-1593 (18 Oct 2026): CI ran the full gate on every push, never cancelled an older run on the
   same branch, had no job timeout and no Next build cache — R-1424, Actions hit the spending
   limit. These tests parse .github/workflows/ci.yml (so a YAML slip fails here, not on GitHub)
   and pin the savings plus the fact that the checks themselves did not change. */

type Step = { name?: string; run?: string; uses?: string; with?: Record<string, string> };
type Job = { "timeout-minutes"?: number; steps: Step[] };
type Workflow = { concurrency: { group: string; "cancel-in-progress": string | boolean }; jobs: Record<string, Job> };

const root = fileURLToPath(new URL("../../../", import.meta.url));
const wf = yaml.load(readFileSync(`${root}.github/workflows/ci.yml`, "utf8")) as Workflow;

describe("ci.yml — R-1593 cost controls", () => {
  it("one concurrency group per workflow + ref, cancelling older runs except on main/deploy", () => {
    expect(wf.concurrency.group).toBe("ci-${{ github.workflow }}-${{ github.ref }}");
    const cancel = String(wf.concurrency["cancel-in-progress"]);
    expect(cancel).toContain("github.ref != 'refs/heads/main'");
    expect(cancel).toContain("github.ref != 'refs/heads/deploy'");
  });

  it("every job has a timeout of at most 30 minutes", () => {
    for (const [name, job] of Object.entries(wf.jobs)) {
      expect(job["timeout-minutes"], name).toBeGreaterThan(0);
      expect(job["timeout-minutes"], name).toBeLessThanOrEqual(30);
    }
  });

  it("restores production/.next/cache right before the build, keyed on lockfile + source", () => {
    const steps = wf.jobs.checks.steps;
    const cacheAt = steps.findIndex((s) => s.uses?.startsWith("actions/cache@"));
    const buildAt = steps.findIndex((s) => s.run === "npm run build");
    expect(cacheAt).toBeGreaterThan(-1);
    expect(cacheAt).toBeLessThan(buildAt);
    const w = steps[cacheAt].with ?? {};
    // R-1619: a stale .tsbuildinfo restored from an older commit ran next build's type check
    // out of heap. The cache keeps webpack/SWC output but never that file.
    const paths = String(w.path).split("\n").map((p) => p.trim()).filter(Boolean);
    expect(paths).toEqual(["production/.next/cache", "!production/.next/cache/.tsbuildinfo"]);
    expect(w.key).toContain("hashFiles('production/package-lock.json')");
    expect(w.key).toContain("production/src/**");
    expect(w["restore-keys"]).toContain("hashFiles('production/package-lock.json')");
  });

  it("npm download cache stays on in both jobs", () => {
    for (const job of Object.values(wf.jobs)) {
      const node = job.steps.find((s) => s.uses?.startsWith("actions/setup-node@"));
      expect(node?.with?.cache).toBe("npm");
    }
  });

  it("the checks themselves are unchanged (same commands, same order)", () => {
    const runs = (j: string) => wf.jobs[j].steps.filter((s) => s.run).map((s) => s.run!.trim());
    expect(runs("checks")).toEqual([
      "node scripts/migration-order-check.mjs",
      "node scripts/check-config-drift.mjs",
      'node scripts/ops/secret-scan.mjs --diff "$SECRET_SCAN_BASE"',
      "npm ci",
      "npm audit --omit=dev --audit-level=high",
      "npm run typecheck",
      "npm run test",
      "npm run lint",
      "npm run lint:ratchet",
      "npm run build",
    ]);
    expect(runs("e2e-smoke")).toEqual([
      "npm ci",
      "npx playwright install --with-deps chromium",
      "npx playwright test smoke.spec.ts money-spine.spec.ts suite-health.spec.ts --project=chromium",
    ]);
  });
});
