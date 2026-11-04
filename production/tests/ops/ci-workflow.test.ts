import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error — js-yaml ships no types (it is installed via eslint, already in the lockfile)
import yaml from "js-yaml";
// @ts-expect-error — plain .mjs, no types
import { workflowVerdict, failingSteps, failingTestNames } from "../../scripts/ops/worker-lock.mjs";

/* R-1593 (18 Oct 2026): CI ran the full gate on every push, never cancelled an older run on the
   same branch, had no job timeout and no Next build cache — R-1424, Actions hit the spending
   limit. These tests parse .github/workflows/ci.yml (so a YAML slip fails here, not on GitHub)
   and pin the savings plus the fact that the checks themselves did not change. */

type Step = { name?: string; run?: string; uses?: string; with?: Record<string, string | number>; env?: Record<string, string>; "continue-on-error"?: boolean };
type Job = {
  "timeout-minutes"?: number;
  "continue-on-error"?: boolean;
  needs?: string[];
  if?: string;
  strategy?: { "fail-fast"?: boolean; matrix?: { shard?: number[] } };
  steps: Step[];
};
type Workflow = { concurrency: { group: string; "cancel-in-progress": string | boolean }; jobs: Record<string, Job> };

const root = fileURLToPath(new URL("../../../", import.meta.url));
const wf = yaml.load(readFileSync(`${root}.github/workflows/ci.yml`, "utf8")) as Workflow;

describe("sql-tests.yml — R-1989 manager-pardeep keeps its running run", () => {
  const sql = yaml.load(readFileSync(`${root}.github/workflows/sql-tests.yml`, "utf8")) as Workflow;
  it("cancels older runs on every ref except manager-pardeep (main/deploy behaviour unchanged)", () => {
    expect(sql.concurrency.group).toBe("sql-tests-${{ github.ref }}");
    expect(String(sql.concurrency["cancel-in-progress"])).toBe("${{ github.ref != 'refs/heads/manager-pardeep' }}");
  });
});

describe("ci.yml — R-1593 cost controls", () => {
  it("one concurrency group per workflow + ref, cancelling older runs except on main/deploy", () => {
    expect(wf.concurrency.group).toBe("ci-${{ github.workflow }}-${{ github.ref }}");
    const cancel = String(wf.concurrency["cancel-in-progress"]);
    expect(cancel).toContain("github.ref != 'refs/heads/main'");
    expect(cancel).toContain("github.ref != 'refs/heads/deploy'");
  });

  /* R-1989 (26 Oct 2026): 13:28–14:21Z every manager-pardeep run was cancelled by the next push
     (CI takes ~29 min, pushes came faster) — no run finished and `worker-lock ci` timed out.
     manager-pardeep now keeps its running run like main/deploy; GitHub keeps only the newest
     pending one, which then tests every commit pushed meanwhile. */
  it("R-1989: a running CI on manager-pardeep is never cancelled; other branches unchanged", () => {
    const cancel = String(wf.concurrency["cancel-in-progress"]);
    expect(cancel).toBe(
      "${{ github.ref != 'refs/heads/main' && github.ref != 'refs/heads/deploy' && github.ref != 'refs/heads/manager-pardeep' }}",
    );
  });

  it("every job has a timeout of at most 30 minutes (R-2349: no 45-min `checks` job any more)", () => {
    for (const [name, job] of Object.entries(wf.jobs)) {
      expect(job["timeout-minutes"], name).toBeGreaterThan(0);
      expect(job["timeout-minutes"], name).toBeLessThanOrEqual(30);
    }
  });

  it("restores production/.next/cache right before the build, keyed on lockfile + source", () => {
    const steps = wf.jobs.build.steps;
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

  it("npm download cache stays on in every job that installs", () => {
    for (const [name, job] of Object.entries(wf.jobs)) {
      if (!job.steps.some((s) => s.run === "npm ci")) continue;
      const node = job.steps.find((s) => s.uses?.startsWith("actions/setup-node@"));
      expect(node?.with?.cache, name).toBe("npm");
    }
  });
});

/* R-2349 (1 Nov 2026): the one `checks` job ran everything in a row (run 41333752288: a 30-min
   job, 45 min with the queue). It is now four parallel gate jobs + a summary `checks`. These pin
   that no check was dropped, changed or made non-blocking on the way. */
describe("ci.yml — R-2349 parallel gate jobs", () => {
  const runs = (j: string) => wf.jobs[j].steps.filter((s) => s.run).map((s) => s.run!.trim());
  const GATE = ["static", "typecheck", "test", "build"];

  it("the same commands as the old single job, each in its job (same order inside it)", () => {
    expect(Object.keys(wf.jobs).sort()).toEqual(["build", "checks", "e2e-smoke", "static", "test", "typecheck"]);
    expect(runs("static")).toEqual([
      "node scripts/migration-order-check.mjs",
      "node scripts/check-config-drift.mjs",
      'node scripts/ops/secret-scan.mjs --diff "$SECRET_SCAN_BASE"',
      "npm ci",
      "npm audit --omit=dev --audit-level=high",
      "npm run lint",
      "npm run lint:ratchet",
    ]);
    expect(runs("typecheck")).toEqual(["npm ci", "npm run typecheck"]);
    // Before R-2349 the tests ran after typecheck's `prisma generate && next typegen`.
    expect(runs("test")).toEqual([
      "npm ci",
      "npx prisma generate && npx next typegen",
      "npm run test -- --shard=${{ matrix.shard }}/2",
    ]);
    expect(runs("build")).toEqual(["npm ci", "npm run build"]);
    expect(runs("e2e-smoke")).toEqual([
      "npm ci",
      "npx playwright install --with-deps chromium",
      "npx playwright test smoke.spec.ts money-spine.spec.ts suite-health.spec.ts --project=chromium",
    ]);
  });

  it("tests run as shards 1/2 and 2/2 of ONE vitest run (`npm run test` is `vitest run`), no fail-fast", () => {
    const pkg = JSON.parse(readFileSync(`${root}production/package.json`, "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.test).toBe("vitest run");
    const t = wf.jobs.test;
    expect(t.strategy?.matrix?.shard).toEqual([1, 2]);
    expect(t.strategy?.["fail-fast"]).toBe(false);
  });

  it("every gate job is blocking; only the advisory npm audit step may continue on error", () => {
    for (const j of [...GATE, "checks"]) {
      expect(wf.jobs[j]["continue-on-error"], j).toBeUndefined();
      for (const s of wf.jobs[j].steps) {
        if (s["continue-on-error"]) expect(s.run, j).toBe("npm audit --omit=dev --audit-level=high");
      }
    }
  });

  it("each job's env is unchanged: migration/secret bases, tsc heap, build env", () => {
    const step = (j: string, run: string) => wf.jobs[j].steps.find((s) => s.run?.trim() === run)!;
    const base = "${{ github.event_name == 'pull_request' && format('origin/{0}', github.base_ref) || github.event.before }}";
    expect(step("static", "node scripts/migration-order-check.mjs").env).toEqual({ MIGRATION_BASE: base });
    expect(step("static", 'node scripts/ops/secret-scan.mjs --diff "$SECRET_SCAN_BASE"').env).toEqual({
      SECRET_SCAN_BASE: base,
      SECRET_SCAN_DENY_TERMS: "${{ secrets.SECRET_SCAN_DENY_TERMS }}",
    });
    expect(step("typecheck", "npm run typecheck").env).toEqual({ NODE_OPTIONS: "--max-old-space-size=8192" });
    const env = step("build", "npm run build").env ?? {};
    expect(Object.keys(env).sort()).toEqual(["CATALOG_ORIGIN", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NODE_OPTIONS"]);
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe("https://api.anutech.in");
    expect(env.NODE_OPTIONS).toBe("--max-old-space-size=6144");
    expect(env.CATALOG_ORIGIN).toBe("http://127.0.0.1:9");
    // The migration check needs the merge-base; the secret scan the diff.
    expect(wf.jobs.static.steps[0].with?.["fetch-depth"]).toBe(0);
  });

  it("`checks` waits for every gate job, always runs, and is red unless all are success", () => {
    const c = wf.jobs.checks;
    expect([...(c.needs ?? [])].sort()).toEqual([...GATE].sort());
    expect(c.if).toBe("always()");
    expect(c.steps).toHaveLength(1);
    expect(c.steps[0].env).toEqual({ RESULTS: "${{ join(needs.*.result, ' ') }}" });
    expect(c.steps[0].run).toContain('[ "$r" = success ] || exit 1');
  });

  it("e2e-smoke stays independent and non-blocking", () => {
    expect(wf.jobs["e2e-smoke"].needs).toBeUndefined();
    expect(wf.jobs["e2e-smoke"]["continue-on-error"]).toBe(true);
  });
});

/* R-2349: worker-lock judges CI by the workflow RUN's conclusion, never by a job called `checks`.
   With four parallel jobs (and a 2-way matrix) GitHub marks the run `failure` when any job fails. */
describe("worker-lock reads a multi-job CI run the same way (R-2349)", () => {
  const run = (conclusion: string, status = "completed") =>
    ({ databaseId: 1, workflowName: "CI", status, conclusion, headSha: "abc", url: "u", createdAt: "2026-11-01T00:00:00Z" });

  it("run-level verdict: success → green, failure → red, in progress → pending", () => {
    const opts = { graceOver: true, ciDone: false };
    expect(workflowVerdict("CI", [run("success")], [], opts).state).toBe("green");
    expect(workflowVerdict("CI", [run("failure")], [], opts).state).toBe("red");
    expect(workflowVerdict("CI", [run("", "in_progress")], [], opts).state).toBe("pending");
  });

  it("failing steps are named per job, whatever the job is called (shard, build, summary)", () => {
    const jobs = {
      jobs: [
        { name: "static", steps: [{ name: "Run npm run lint", conclusion: "success" }] },
        { name: "test (1, 2)", steps: [{ name: "Run npm run test -- --shard=1/2", conclusion: "failure" }] },
        { name: "test (2, 2)", steps: [{ name: "Run npm run test -- --shard=2/2", conclusion: "success" }] },
        { name: "build", steps: [{ name: "Build (catches what typecheck cannot — see comment)", conclusion: "success" }] },
        { name: "checks", steps: [{ name: "All gate jobs green", conclusion: "failure" }] },
      ],
    };
    expect(failingSteps(jobs)).toEqual(["test (1, 2) › Run npm run test -- --shard=1/2", "checks › All gate jobs green"]);
  });

  it("failing vitest names are read from any job's --log-failed lines", () => {
    const log = [
      "test (1, 2)\tRun npm run test -- --shard=1/2\t2026-11-01T18:25:00.1Z  FAIL  tests/a.test.ts > a breaks",
      "test (2, 2)\tRun npm run test -- --shard=2/2\t2026-11-01T18:25:00.2Z  FAIL  tests/b.test.ts > b breaks",
    ].join("\n");
    expect(failingTestNames(log)).toEqual(["tests/a.test.ts > a breaks", "tests/b.test.ts > b breaks"]);
  });
});
