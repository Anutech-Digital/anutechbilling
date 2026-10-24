/**
 * R-1104: every job's schedule, in the words the /automation page shows — and the same
 * schedule Cloud Scheduler is given (scripts/setup-cloud-scheduler.sh), so the page cannot
 * say "9:00 am" while the scheduler fires at 9:15.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTOMATION_JOBS } from "./jobs";
import { JOB_CRON, describeCron, scheduleFor } from "./schedule";

const SCRIPT = readFileSync(join(process.cwd(), "scripts", "setup-cloud-scheduler.sh"), "utf8");
/** Active (uncommented) lines only: "resellersos-<job>|<cron>|/api/cron/<job>|…" */
const scheduled = new Map(
  [...SCRIPT.matchAll(/^\s*"resellersos-([a-z0-9-]+)\|([^|]+)\|\/api\/cron\/([a-z0-9-]+)\|/gm)]
    .map((m) => [m[3], m[2].trim()] as const),
);

describe("schedule matches Cloud Scheduler", () => {
  it("every job has a schedule, and it is the one in setup-cloud-scheduler.sh", () => {
    for (const job of Object.keys(AUTOMATION_JOBS)) {
      expect(scheduled.get(job), job).toBeDefined();
      expect(JOB_CRON[job as keyof typeof JOB_CRON], job).toBe(scheduled.get(job));
    }
  });

  it("every schedule can be said in plain English", () => {
    for (const cron of Object.values(JOB_CRON)) expect(() => describeCron(cron)).not.toThrow();
  });
});

describe("describeCron", () => {
  it.each([
    ["0 9 * * *", "Every day at 9:00 am"],
    ["15 9 * * *", "Every day at 9:15 am"],
    ["1 21 * * *", "Every day at 9:01 pm"],
    ["0 0 * * *", "Every day at 12:00 am (midnight)"],
    ["30 0 1 * *", "On the 1st of every month at 12:30 am"],
    ["0 */6 * * *", "Every 6 hours"],
    ["*/2 9-19 * * 1-5", "Every 2 minutes from 9:00 am to 7:58 pm, Monday to Friday"],
    ["*/15 8-21 * * *", "Every 15 minutes from 8:00 am to 9:45 pm"],
    ["0 9-19 * * 1-6", "Every hour from 9:00 am to 7:00 pm, Monday to Saturday"],
    ["*/15 * * * *", "Every 15 minutes, day and night"],
    ["30 10 * * 1-5", "At 10:30 am, Monday to Friday"],
    ["* * * * *", "Every minute, day and night"],
    ["*/30 9-20 * * *", "Every 30 minutes from 9:00 am to 8:30 pm"],
  ])("%s → %s", (cron, words) => {
    expect(describeCron(cron)).toBe(words);
  });

  it("refuses a shape it does not know rather than guessing", () => {
    expect(() => describeCron("0 9 * 3 *")).toThrow();
  });
});

describe("scheduleFor", () => {
  it("adds the time zone", () => {
    expect(scheduleFor("renewals")).toBe("Every day at 9:00 am (India time)");
  });
});
