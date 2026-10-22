import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* S22 (28 Sep 2026): the renewals cron read the tenant, its ingest mailboxes and the
   customer once PER SUBSCRIPTION, and processed rows strictly one at a time. The route
   is a Next handler bound to a service-role client, so this pins the shape in source:
   look-ups prefetched before the loop, the loop bounded-concurrent. */

const src = readFileSync(join(process.cwd(), "src", "app", "api", "cron", "renewals", "route.ts"), "utf8");
const live = src.slice(src.indexOf("async function handle("), src.indexOf("async function planOnly("));
const loopAt = live.indexOf("await mapLimit(");
const beforeLoop = live.slice(0, loopAt);
const loop = live.slice(loopAt);

describe("renewals cron — prefetch + bounded concurrency", () => {
  it("processes subscriptions through mapLimit, not a serial for-loop", () => {
    expect(loopAt).toBeGreaterThan(0);
    expect(live).not.toMatch(/for \(const sub of subs/);
    expect(loop).toMatch(/await mapLimit\(allSubs, RENEWALS_CONCURRENCY,/);
    expect(src).toMatch(/const RENEWALS_CONCURRENCY = [1-9]\d*;/);
  });

  it("reads tenants, ingest mailboxes and customers BEFORE the loop, in chunks", () => {
    for (const table of ["tenants", "user_google_tokens", "customers"]) {
      expect(beforeLoop, `${table} is not prefetched`).toContain(`from("${table}")`);
      expect(loop, `${table} is still read per subscription`).not.toContain(`from("${table}")`);
    }
    expect(beforeLoop.match(/chunk\((tenantIds|customerIds), PREFETCH_CHUNK\)/g)?.length).toBe(2);
  });

  it("selects the same tenant and customer columns the per-row reads did", () => {
    expect(beforeLoop).toContain('"id, name, email, phone, gstin, address, grace_period_days, state_code, logo_url"');
    /* R-1736 added gst_treatment: the per-row place-of-supply check (isInterStateSupply …
       treatment: customer?.gst_treatment) now reads it, so the prefetch must carry it (R-1743). */
    expect(beforeLoop).toContain('"id, name, contact_name, contact_email, gstin, contact_phone, state_code, gst_treatment"');
    expect(live).toContain("treatment: customer?.gst_treatment");
  });

  it("an early exit inside the per-row callback is `return`, never a stray `continue`", () => {
    expect(loop).not.toMatch(/\bcontinue;/);
  });
});
