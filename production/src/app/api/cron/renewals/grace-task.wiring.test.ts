import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* R-1621: grace over → ONE owner task, never an automatic pause. The route is a Next handler
   on a service-role client; the SQL side is proven by supabase/tests/r1621_renewal_grace_task.test.sql.
   This pins the wiring. */
const src = readFileSync(join(process.cwd(), "src", "app", "api", "cron", "renewals", "route.ts"), "utf8");
const live = src.slice(src.indexOf("async function handle("), src.indexOf("async function planOnly("));
const dry = src.slice(src.indexOf("async function planOnly("));
const sendNow = readFileSync(join(process.cwd(), "src", "app", "api", "renewals", "send-now", "route.ts"), "utf8");

describe("renewals cron — grace over (R-1621)", () => {
  it("raises the owner's task and does not pause the subscription itself", () => {
    expect(live).toContain('"raise_renewal_grace_task"');
    expect(live).not.toMatch(/status:\s*"paused"/);
    expect(live).not.toMatch(/renewal_state:\s*"suspended"/);
  });

  it("live run, dry run and Send now all use the effective grace (trusted customer, +N days)", () => {
    for (const s of [live, dry, sendNow]) {
      expect(s).toContain("effectiveGraceDays(");
      expect(s).toContain("readGraceOverrides(");
      expect(s).not.toMatch(/graceDays:\s*tenant\.grace_period_days/);
    }
  });

  it("the mails get the IST stop date and an IST renewal date", () => {
    for (const s of [live, sendNow]) {
      expect(s).toContain("stopDate:        formatIstDate(serviceStopDate(");
      expect(s).not.toContain('toLocaleDateString("en-IN"');
    }
  });
});
