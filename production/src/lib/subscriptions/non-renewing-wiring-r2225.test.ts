/**
 * R-2225 wiring: a subscription marked Won't renew (auto_renew = false) gets no renewal quote,
 * no next-term roll and no reminder, from the cron or by hand — and the cron lapses it after its
 * renewal date (RN-24). Source checks: these routes need a live DB + auth to run.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const CRON = read("src/app/api/cron/renewals/route.ts");
const GENERATE = read("src/app/api/subscriptions/[id]/generate-renewal-quote/route.ts");
const SEND_NOW = read("src/app/api/renewals/send-now/route.ts");

describe("RN-24: the renewals cron (read only for R-2225)", () => {
  it("reads only auto_renew = true subscriptions for quotes, reminders and split-term rolls", () => {
    const fn = CRON.slice(CRON.indexOf("function readRenewableSubs"), CRON.indexOf("/** Body shape"));
    expect(fn).toMatch(/\.eq\("auto_renew", true\)/);
    expect(fn).toMatch(/\.eq\("status", "active"\)/);
    /* the live pass works on that list only */
    expect(CRON).toMatch(/allSubs = await readRenewableSubs\(supabase\)/);
  });

  it("lapses an active, non-renewing subscription once its renewal date has passed — and nothing else", () => {
    const step = CRON.slice(CRON.indexOf("RN-24: lapse NON-renewing"), CRON.indexOf("Fetch all active subscriptions"));
    expect(step).toMatch(/\.update\(\{ status: "expired" \}\)/);
    expect(step).toMatch(/\.eq\("status", "active"\)/);
    expect(step).toMatch(/\.eq\("auto_renew", false\)/);
    expect(step).toMatch(/\.lt\("renewal_date", todayIso\)/);
    expect(step).not.toMatch(/quotes|invoices|createRenewalQuote/);
  });

  it("the dry-run plan counts the same set (auto_renew = true)", () => {
    const plan = CRON.slice(CRON.indexOf("async function planOnly"));
    expect(plan).toMatch(/\.eq\("auto_renew", true\)/);
  });
});

describe("Generate renewal quote / Send now refuse a non-renewing subscription", () => {
  for (const [name, src] of [["generate-renewal-quote", GENERATE], ["send-now", SEND_NOW]] as const) {
    it(`${name}: reads auto_renew and refuses before any quote is made`, () => {
      expect(src).toMatch(/select\([\s\S]*?auto_renew`/);
      const guard = src.indexOf("renewalRefusal(sub)");
      expect(guard).toBeGreaterThan(0);
      expect(src.slice(guard, guard + 200)).toMatch(/code: "non_renewing"/);
      for (const later of ["createRenewalQuote(", ".from(\"quotes\")", "sendRenewal"]) {
        const at = src.indexOf(later);
        if (at >= 0) expect(at, `${name}: ${later} after the guard`).toBeGreaterThan(guard);
      }
    });
  }
});
