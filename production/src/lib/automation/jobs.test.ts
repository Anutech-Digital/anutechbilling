/**
 * R-897: every cron route has a switch, and every switch is a real cron route.
 */
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { AUTOMATION_JOBS, CUSTOMER_MESSAGES, isAutomationSwitch, stateOf } from "./jobs";

const CRON_DIR = join(process.cwd(), "src", "app", "api", "cron");
const cronRoutes = readdirSync(CRON_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
  .map((d) => d.name)
  .sort();

describe("the job registry", () => {
  it("lists every cron route", () => {
    expect(cronRoutes.filter((r) => !(r in AUTOMATION_JOBS))).toEqual([]);
  });
  it("lists nothing that is not a cron route", () => {
    expect(Object.keys(AUTOMATION_JOBS).filter((j) => !cronRoutes.includes(j))).toEqual([]);
  });
  it("job names fit the database check", () => {
    for (const j of [...Object.keys(AUTOMATION_JOBS), CUSTOMER_MESSAGES]) expect(j).toMatch(/^[a-z0-9_-]{1,64}$/);
  });
  it("knows the customer_messages switch", () => {
    expect(isAutomationSwitch(CUSTOMER_MESSAGES)).toBe(true);
    expect(isAutomationSwitch("not-a-job")).toBe(false);
  });
});

describe("stateOf", () => {
  it("a missing row is off", () => expect(stateOf(null)).toBe("off"));
  it("disabled is off even with dry run", () => expect(stateOf({ enabled: false, dry_run: true })).toBe("off"));
  it("dry run", () => expect(stateOf({ enabled: true, dry_run: true })).toBe("dry_run"));
  it("on", () => expect(stateOf({ enabled: true, dry_run: false })).toBe("on"));
});
