/**
 * Domain renewals are only as right as their wiring (AGENTS.md L75, L85): the logic in
 * lib/domains/renewal.ts is tested on its own, and these assert the call sites that decide
 * whether a paid renewal renews a domain or — the expensive mistake — registers it again.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");
/** Comments stripped, so prose about a rule cannot satisfy or break the scan (L46). */
const code = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the payment webhook", () => {
  const w = code("app/api/webhooks/razorpay/route.ts");

  it("finds the domain subscription being renewed BEFORE record_payment rolls it forward", () => {
    const lookup = w.indexOf('.eq("renewal_quote_id", quote.id)');
    const rpc = w.indexOf('admin.rpc("record_payment"');
    expect(lookup).toBeGreaterThan(-1);
    expect(rpc).toBeGreaterThan(lookup);
  });

  it("a paid renewal is queued with its renewal plan, behind the renewal switch — domain and hosting alike", () => {
    expect(w).toMatch(/renewedSub\?\.vendor === "domain" \? DOMAIN_RENEWAL_PLAN : renewedSub\?\.vendor === "hosting" \? HOSTING_RENEWAL_PLAN : null/);
    // The renewal plan still wins first; a new sale's hosting account then carries its own
    // plan (R-032), and only after that the quote's.
    expect(w).toMatch(/plan:\s*renewalPlan \?\? product\.plan \?\? quote\.plan/);
    expect(w).toMatch(/renewalPlan \? domainRenewalEnabled\(\) : domainRegistrationEnabled\(\)/);
    expect(w).toMatch(/renewalPlan \? hostingRenewalEnabled\(\) : hostingProvisioningEnabled\(\)/);
  });

  it("a renewal is never read from the lines as a new sale; a Workspace renewal queues nothing", () => {
    expect(w).toMatch(/const products = isRenewal\s*\?\s*renewalPlan && renewalDomain/);
    expect(w).toMatch(/:\s*\[\]\s*:\s*provisioningProducts\(/);
  });

  it("creates domain subscriptions only on a first sale, never on a renewal", () => {
    expect(w).toMatch(/if \(!isRenewal\)/);
    expect(w).toMatch(/domainSubscriptionsToCreate\(quote\.line_items, domainItemIds\)/);
  });
});

describe("the queue", () => {
  const p = code("lib/provisioning/provisioning.server.ts");
  it("the registration list excludes renewal rows, keeping those with no plan", () => {
    expect(p).toMatch(/plan\.is\.null,plan\.neq\.\$\{DOMAIN_RENEWAL_PLAN\}/);
  });
  it("the renewal list takes only renewal rows", () => {
    expect(p).toMatch(/q\.eq\("plan", DOMAIN_RENEWAL_PLAN\)/);
  });
  it("hosting: new-account list excludes renewals, renewal list takes only them", () => {
    expect(p).toMatch(/plan\.is\.null,plan\.neq\.\$\{HOSTING_RENEWAL_PLAN\}/);
    expect(p).toMatch(/q\.eq\("plan", HOSTING_RENEWAL_PLAN\)/);
    expect(code("app/api/cron/provision-hosting/route.ts")).toMatch(/listReadyHostingRequests\(\)/);
    const r = code("app/api/cron/renew-hosting/route.ts");
    expect(r).toMatch(/listReadyHostingRenewals\(\)/);
    expect(r).not.toMatch(/listReadyHostingRequests/);
  });

  it("register-domains reads the registration list; renew-domains the renewal list", () => {
    expect(code("app/api/cron/register-domains/route.ts")).toMatch(/listReadyDomainRequests\(\)/);
    const r = code("app/api/cron/renew-domains/route.ts");
    expect(r).toMatch(/listReadyDomainRenewals\(\)/);
    expect(r).not.toMatch(/listReadyDomainRequests/);
  });
});

describe("the renewals cron", () => {
  it("prices a DOMAIN subscription live, and everything else through the shared helper", () => {
    const c = code("app/api/cron/renewals/route.ts");
    expect(c).toMatch(/sub\.vendor === "domain" && sub\.domain\s*\?\s*await createDomainRenewalQuote\(/);
    expect(c).toMatch(/:\s*await createOrGetRenewalQuote\(/);
  });
  it("holds a domain's reminder when the live price is unavailable, rather than emailing no price", () => {
    /* R-1571 widened the hold from domains to every vendor; the domain still gets its own reason. */
    const cron = code("app/api/cron/renewals/route.ts");
    expect(cron).toMatch(/if \(!quoteResult\) \{/);
    expect(cron).toContain("the live renewal price could not be read");
  });
});
