/**
 * R-2597 — r909-live-cutover.mjs: `scheduler-resume` resumes only Anutech-internal cron jobs; the six jobs
 * that mail a client tenant's customers resume only by name with `scheduler-resume-customer <job>...`.
 * Every run here is a DRY RUN (no --run) — it only prints the gcloud lines, nothing is executed.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  CRON_JOBS, INTERNAL_JOBS, CUSTOMER_MAIL_JOBS, customerJobsFromArgs,
  // @ts-expect-error — plain .mjs ops script, no types
} from "../../scripts/ops/r909-live-cutover.mjs";

const SCRIPT = path.resolve(__dirname, "../../scripts/ops/r909-live-cutover.mjs");
const CUSTOMER = ["renewals", "invoice-dunning", "billing", "birthday-greetings", "trial-expiry", "compliance-reminders"]
  .map((j) => `resellersos-${j}`);

function dry(...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  const resumed = [...r.stdout.matchAll(/\[dry-run\] gcloud scheduler jobs resume (\S+)/g)].map((m) => m[1]);
  return { code: r.status, out: r.stdout, resumed };
}

describe("cron job split", () => {
  it("the 15 jobs are exactly internal + customer-mail, no overlap", () => {
    expect(CRON_JOBS).toHaveLength(15);
    expect([...CUSTOMER_MAIL_JOBS].sort()).toEqual([...CUSTOMER].sort());
    expect(INTERNAL_JOBS.filter((j: string) => CUSTOMER_MAIL_JOBS.includes(j))).toEqual([]);
    expect(new Set([...INTERNAL_JOBS, ...CUSTOMER_MAIL_JOBS]).size).toBe(15);
  });

  it("customerJobsFromArgs accepts short and full names, refuses internal/unknown/empty", () => {
    expect(customerJobsFromArgs(["renewals", "resellersos-billing", "renewals"])).toEqual(["resellersos-renewals", "resellersos-billing"]);
    expect(() => customerJobsFromArgs(["health-digest"])).toThrow(/not a customer-mail job/);
    expect(() => customerJobsFromArgs(["renewal"])).toThrow(/not a customer-mail job/);
    expect(() => customerJobsFromArgs([])).toThrow(/at least one/);
  });
});

describe("dry-run output", () => {
  it("scheduler-resume resumes only the internal jobs and lists the customer ones as still paused", () => {
    const { code, out, resumed } = dry("scheduler-resume");
    expect(code).toBe(0);
    expect(resumed).toEqual(INTERNAL_JOBS);
    for (const j of CUSTOMER) expect(resumed).not.toContain(j);
    expect(out).toMatch(/NOT resumed here/);
    expect(out).toMatch(/dry run only/);
  });

  it("a step that takes no names refuses extra words (mixed-up 'scheduler-resume renewals')", () => {
    const { code, resumed, out } = dry("scheduler-resume", "renewals");
    expect(code).toBe(1);
    expect(resumed).toEqual([]);
    expect(out).toMatch(/REFUSED/);
  });

  it("scheduler-resume-customer resumes only the named customer jobs", () => {
    const { code, resumed, out } = dry("scheduler-resume-customer", "renewals", "billing");
    expect(code).toBe(0);
    expect(resumed).toEqual(["resellersos-renewals", "resellersos-billing"]);
    expect(out).toMatch(/not resumed by this call .*resellersos-invoice-dunning/);
  });

  it("scheduler-resume-customer refuses an internal job, a typo and no names — and resumes nothing", () => {
    for (const args of [["health-digest"], ["renewals", "renewal"], []]) {
      const { code, resumed, out } = dry("scheduler-resume-customer", ...args);
      expect(code).toBe(1);
      expect(resumed).toEqual([]);
      expect(out).toMatch(/REFUSED/);
    }
  });
});
