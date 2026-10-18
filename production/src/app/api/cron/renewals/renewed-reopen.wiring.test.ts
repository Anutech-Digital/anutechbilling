import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* R-1562 + R-1571 (audit 18 Oct 2026). The route is a Next handler on a service-role
   client, so these pin the shape in source; the behaviour itself is proven on the pure
   cadence in lib/renewals/renewed-rearm.test.ts. */

const read = (...p: string[]) => readFileSync(join(process.cwd(), "src", ...p), "utf8");
const cron = read("app", "api", "cron", "renewals", "route.ts");
const live = cron.slice(cron.indexOf("async function handle("), cron.indexOf("async function planOnly("));
const sendNow = read("app", "api", "renewals", "send-now", "route.ts");
const genQuote = read("app", "api", "subscriptions", "[id]", "generate-renewal-quote", "route.ts");

describe("R-1562 — the cron re-opens a paid row for its new term", () => {
  it("writes renewed → pending, guarded on the state AND date it read, before suspend/email", () => {
    const at = live.indexOf("reopensForNewTerm(sub.renewal_state, decision)");
    expect(at).toBeGreaterThan(0);
    const block = live.slice(at, at + 700);
    expect(block).toContain('.update({ renewal_state: "pending" })');
    expect(block).toContain('.eq("renewal_state", "renewed")');
    expect(block).toContain('.eq("renewal_date", sub.renewal_date!)');
    expect(at).toBeLessThan(live.indexOf("if (decision.shouldSuspend)"));
  });

  it("manual Send now / Generate quote gate on renewalIsSettled, not on the bare 'renewed' state", () => {
    for (const src of [sendNow, genQuote]) {
      expect(src).toContain("renewalIsSettled(sub.renewal_state, sub.renewal_date, sub.term_months)");
      expect(src).not.toMatch(/renewal_state === "renewed"/);
    }
  });
});

describe("R-1571 — no renewal quote, no renewal email", () => {
  it("the cron holds EVERY vendor when the quote could not be built, not only domains", () => {
    expect(live).toMatch(/if \(!quoteResult\) \{/);
    expect(live).not.toMatch(/sub\.vendor === "domain" && !quoteResult/);
  });

  it("no amount is ever made up from mrr × 12 in a reminder", () => {
    expect(cron).not.toMatch(/mrr \?\? 0\) \* 12/);
    expect(sendNow).not.toMatch(/mrr \?\? 0\) \* 12/);
  });

  it("Send now refuses with a reason when the quote could not be built", () => {
    const at = sendNow.indexOf("if (!quoteResult) {");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(sendNow.indexOf("sendCustomerEmail("));
  });
});
