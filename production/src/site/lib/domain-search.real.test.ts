/**
 * Domain search REAL, not faked (merge Phase-1, 1 Sep 2026) — source pins.
 * The hero box used a deterministic string-hash for AVAILABLE/TAKEN and
 * hardcoded catalogue prices. It must never regress to a guess.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const search = readFileSync(join(process.cwd(), "src/site/components/home/DomainSearch.tsx"), "utf8");
// R-1606/R-1607 (19 Oct 2026): the always-on DomainSearchDock was never mounted and is deleted;
// the /domains page (DomainLanding) is the search box visitors use, so it is pinned instead.
const landing = readFileSync(join(process.cwd(), "src/site/components/domains/DomainLanding.tsx"), "utf8");
const lookup = readFileSync(join(process.cwd(), "src/site/lib/domain-search.ts"), "utf8");
// The route and the lookup it calls, read together: since 24 Sep 2026 the lookup lives in
// lib/domains/live-lookup.ts so the checkout charges the same live price the search shows.
const proxy =
  readFileSync(join(process.cwd(), "src/app/api/domains/availability/route.ts"), "utf8") +
  readFileSync(join(process.cwd(), "src/lib/domains/live-lookup.ts"), "utf8");
const config = readFileSync(join(process.cwd(), "src/site/lib/config.ts"), "utf8");

describe("DomainSearch reads real availability", () => {
  it("the fake hash is gone", () => {
    for (const src of [search, lookup]) {
      expect(src).not.toContain("h % 4");
      expect(src).not.toMatch(/function taken\(/);
      expect(src).not.toMatch(/charCodeAt\(0\)\) % 997/);
    }
  });
  /* The lookup moved into ONE module when the always-on search dock was added
     (2 Sep 2026) — two copies of an availability+price call is how they drift.
     So the proxy call is asserted where it now lives, and the hero is asserted
     to go through it rather than rolling its own fetch. */
  it("the shared lookup calls the site's availability proxy", () => {
    expect(lookup).toContain("/api/domains/availability");
  });
  it("every caller goes through that one lookup, not its own fetch", () => {
    /* Comments are not code — both callers legitimately NAME the proxy while
       explaining themselves. Strip them, then assert on what actually runs. */
    const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    for (const [name, src] of [["hero", search], ["/domains", landing]] as const) {
      expect(src, `${name} should import searchDomains`).toContain("searchDomains");
      expect(code(src), `${name} must not fetch availability itself`).not.toContain("/api/domains/availability");
    }
  });
  it("it does not import the hardcoded TLD catalogue for pricing any more", () => {
    // Prices now come from the API response, not catalog.ts.
    expect(search).not.toMatch(/from "@\/lib\/data\/catalog"/);
  });
});

describe("availability proxy points at the platform via config, fails honest", () => {
  it("forwards to DOMAIN_AVAILABILITY_API and never fabricates on error", () => {
    expect(proxy).toContain("DOMAIN_AVAILABILITY_API");
    expect(proxy).toContain("502");
    expect(proxy).not.toContain("available: true"); // no invented result
  });
  it("config keeps the platform address in ONE place, on a custom domain (not run.app)", () => {
    expect(config).toContain("DOMAIN_AVAILABILITY_API");
    expect(config).toContain("app.anutech.in");
    expect(config).not.toMatch(/DOMAINS_APP_URL[\s\S]{0,120}run\.app/);
  });
});
