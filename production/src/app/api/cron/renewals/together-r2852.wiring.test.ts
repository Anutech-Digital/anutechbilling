/**
 * R-2852 — the renewals cron and Send now remind about a renewal quote billed TOGETHER once per step
 * (rev-r2849 A / M1). The rule itself is tested in lib/renewals/together-reminder.test.ts; these pin
 * the call sites (AGENTS.md: wiring is where a tested rule gets lost).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const code = (p: string) => readFileSync(join(__dirname, "..", "..", "..", "..", p), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("renewals cron", () => {
  const c = code("app/api/cron/renewals/route.ts");

  it("reads the together quotes once, after the plan-change release moved links, and fails the run on a read error", () => {
    const read = c.indexOf("readTogetherQuotes(supabase as unknown as TogetherReadClient, allSubs.map((s) => s.renewal_quote_id))");
    expect(read).toBeGreaterThan(c.indexOf("dropReleasedLinks(allSubs"));
    expect(read).toBeLessThan(c.indexOf("await mapLimit(allSubs"));
    expect(c).toMatch(/return cronDbFailure\("renewals", e, `together quotes read failed/);
  });

  it("another member skips BEFORE any quote, WhatsApp or email — logged with the reason, state synced", () => {
    const skip = c.indexOf('together.kind === "member"');
    expect(skip).toBeGreaterThan(c.indexOf("attemptsToday"));
    expect(skip).toBeLessThan(c.indexOf("createOrGetRenewalQuote({"));
    expect(skip).toBeLessThan(c.indexOf("wa.send({"));
    const block = c.slice(skip, c.indexOf("return;", skip));
    expect(block).toMatch(/renewal_email_log"\)\.insert\(\{[\s\S]*status:\s*"skipped"[\s\S]*error_message:\s*together\.reason/);
    expect(block).toMatch(/update\(\{ renewal_state: decision\.targetState \}\)/);
  });

  it("the lead's email + WhatsApp name every plan, the seats added up and the plan list; amount stays the quote's", () => {
    expect(c).toMatch(/plan:\s*togetherText\?\.planName \?\? sub\.plan/);
    expect(c).toMatch(/planName:\s*togetherText\?\.planName \?\? sub\.plan,\s*seats:\s*togetherText\?\.seats \?\? sub\.seats,\s*amount:\s*renewalQuote\.amount,\s*planLines:\s*togetherText\?\.planLines/);
  });

  it("the dry run counts the same: other members plan no email", () => {
    const dry = c.slice(c.indexOf("async function planOnly"));
    expect(dry).toMatch(/readTogetherQuotes\(/);
    expect(dry).toMatch(/togetherRole\(sub\.id, sub\.renewal_quote_id, togetherByQuote[\s\S]*?\.kind === "member"\)\s*\{\s*togetherSkipped \+= 1;\s*continue;/);
  });
});

describe("Send now", () => {
  const s = code("app/api/renewals/send-now/route.ts");

  it("one email for the whole together quote, whichever member was pressed; logged on every member", () => {
    expect(s).toMatch(/readTogetherQuotes\(supabase as unknown as TogetherReadClient, \[renewalQuoteId\]\)/);
    expect(s).toMatch(/planName:\s*togetherText\?\.planName \?\? sub\.plan/);
    expect(s).toMatch(/planLines:\s*togetherText\?\.planLines/);
    expect(s).toMatch(/const loggedOn = together \? together\.members\.map\(\(m\) => m\.subscriptionId\) : \[sub\.id\]/);
    expect(s).toMatch(/renewal_email_log"\)\.insert\(loggedOn\.map\(/);
  });

  it("a failed together read sends nothing (503) — never the whole amount against one plan", () => {
    const at = s.indexOf("readTogetherQuotes(");
    expect(at).toBeLessThan(s.indexOf("sendCustomerEmail("));
    expect(s.slice(at, at + 600)).toMatch(/status: 503/);
  });
});
