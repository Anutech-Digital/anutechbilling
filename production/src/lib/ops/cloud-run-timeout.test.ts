import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* S22 (28 Sep 2026): Cloud Scheduler waits 540s for a cron; Cloud Run's default request
   timeout is 300s. Every cron longer than five minutes was killed halfway, and the
   scheduler's retry started it again from the top. cloudbuild.yaml (the only deploy path since R-884) must set a service
   timeout at least as long as the longest scheduler deadline. */

const prod = process.cwd();
const read = (...p: string[]) => readFileSync(join(...p), "utf8");

function schedulerDeadlines(): number[] {
  const src = read(prod, "scripts", "setup-cloud-scheduler.sh");
  return [...src.matchAll(/--attempt-deadline=(\d+)s/g)].map((m) => Number(m[1]));
}

function timeoutOf(src: string): number | null {
  const m = /--timeout[= ](\d+)s?\b/.exec(src);
  return m ? Number(m[1]) : null;
}

describe("Cloud Run timeout covers the scheduler deadline", () => {
  const deadline = Math.max(...schedulerDeadlines());

  it("the scheduler script declares a deadline", () => {
    expect(schedulerDeadlines().length).toBeGreaterThan(0);
  });

  it("deploy.sh never deploys directly — it ships through cloudbuild.yaml (R-884)", () => {
    // deploy.sh used to run `gcloud run deploy --source .` with its own --timeout. Since R-884
    // it only pushes the gated sha to the `deploy` branch, so cloudbuild.yaml's --timeout
    // (next test) is the one that reaches Cloud Run.
    const code = read(prod, "deploy.sh")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    expect(code).not.toMatch(/gcloud\s+run\s+deploy/);
    expect(code).not.toMatch(/--source/);
    expect(code).toMatch(/deploy-gate\.mjs/);
  });

  it("cloudbuild.yaml's deploy step sets --timeout >= the deadline", () => {
    const cb = read(prod, "..", "cloudbuild.yaml");
    const step = cb.slice(cb.indexOf("- id: deploy"));
    const t = timeoutOf(step.slice(0, step.indexOf("substitutions:")));
    expect(t, "cloudbuild deploy step has no --timeout").not.toBeNull();
    expect(t!).toBeGreaterThanOrEqual(deadline);
    expect(t!).toBeLessThanOrEqual(3600);
  });
});
