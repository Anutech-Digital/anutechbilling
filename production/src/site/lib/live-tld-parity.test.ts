/**
 * R-1599 (18 Oct 2026): /domains, /rates, the homepage teaser and the JSON-LD sent to
 * Google printed catalog.ts TLDS placeholders (.com ₹899) while the checkout charged the live
 * registry price (₹1,049 for this fixture). Every public domain price now comes from
 * getSiteTldPrices — the same rcTldPricing the checkout's lookupDomains prices with.
 *
 * These pin: display === charge for the same price list; a failed registry read keeps the
 * last good live price; with none, no number at all (never the placeholder).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/* unstable_cache needs Next's incremental cache; outside Next it is a pass-through here. */
vi.mock("next/cache", () => ({ unstable_cache: <T,>(fn: T) => fn }));

/* customer-price.json shape (lib/resellerclub): period-keyed per-year rates, as strings. */
const FIXTURE = {
  dotin: { addnewdomain: { "1": "799.0", "2": "760.0" }, renewdomain: { "1": "899.0" }, transferdomain: { "1": "799.0" } },
  domcno: { addnewdomain: { "1": "1049.4" }, renewdomain: { "1": "1249.6" }, transferdomain: { "1": "1049.0" } },
};

let registryUp = true;

function stubRegistry() {
  vi.stubEnv("RESELLERCLUB_RESELLER_ID", "test-reseller");
  vi.stubEnv("RESELLERCLUB_API_KEY", "test-key");
  vi.stubEnv("RESELLERCLUB_API_URL", "https://registry.test");
  vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
    const url = String(u);
    if (!registryUp) return new Response("down", { status: 503 });
    if (url.includes("customer-price")) return new Response(JSON.stringify(FIXTURE));
    if (url.includes("available")) {
      return new Response(JSON.stringify({ "acme.com": { status: "available" }, "acme.in": { status: "available" } }));
    }
    return new Response("not found", { status: 404 });
  }));
}

async function load() {
  vi.resetModules();
  const site = await import("./live-tld-pricing");
  const { lookupDomains } = await import("@/lib/domains/live-lookup");
  const { termTotal } = await import("@/lib/checkout/cart-checkout");
  const { buildRateCard } = await import("./rate-card");
  const { domainOfferCatalog } = await import("./data/domains-landing");
  const { domainTeaser } = await import("./data/domain-teaser");
  /** What the checkout charges for a 1-year registration of acme<tld> (priceDomainLines' path). */
  async function charged(tld: string): Promise<number | null> {
    const live = await lookupDomains("acme", [tld.replace(/^\./, "")]);
    if (!live.ok) return null;
    const hit = live.domains.find((d) => d.domain === `acme${tld}`);
    return hit && hit.priceKnown ? termTotal(hit, 1) : null;
  }
  const rateCard = (tlds: Awaited<ReturnType<typeof site.getSiteTldPrices>>) =>
    buildRateCard({ tlds, hosting: [], editions: [], mailRates: {}, certs: [] }).find((s) => s.id === "domains")!;
  return { site, charged, rateCard, domainOfferCatalog, domainTeaser };
}

const rupee = (n: number) => "₹" + n.toLocaleString("en-IN");

afterEach(() => {
  registryUp = true;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/* Each test re-imports the checkout module (env is read at import) — slow on a busy machine. */
describe("R-1599 — the displayed domain price is the price the checkout charges", { timeout: 30_000 }, () => {
  it(".com and .in: rate table, /rates, JSON-LD and homepage teaser === checkout charge", async () => {
    stubRegistry();
    const { site, charged, rateCard, domainOfferCatalog, domainTeaser } = await load();
    const tlds = await site.getSiteTldPrices();

    for (const tld of [".com", ".in"]) {
      const charge = await charged(tld);
      expect(charge).not.toBeNull();
      const row = tlds.find((t) => t.tld === tld)!;
      expect(row.reg).toBe(charge); // /domains table + result fallback
      expect(row.live).toBe(true);
      expect(rateCard(tlds).rows.find((r) => r.name === tld)!.cells[0]).toBe(rupee(charge!)); // /rates
      const offers = domainOfferCatalog(tlds)!.offers as { name: string; price: number }[];
      expect(offers.find((o) => o.name.startsWith(`${tld} `))!.price).toBe(charge); // JSON-LD
    }
    // The fixture's .com is 1049.4 → both sides round to ₹1,049, not the ₹899 placeholder.
    expect(tlds.find((t) => t.tld === ".com")!.reg).toBe(1049);
    // Renewal is the live renew price, same rounding.
    expect(tlds.find((t) => t.tld === ".com")!.renew).toBe(1250);
    expect(tlds.find((t) => t.tld === ".in")!.renew).toBe(899);
    // Homepage + header teaser.
    expect(domainTeaser(tlds).from).toBe(rupee((await charged(".in"))!));
    expect(domainTeaser(tlds).line).toBe(".in from ₹799/year (renews at ₹899)");
  });

  it("JSON-LD: no lowPrice 0, only live-priced TLDs, ₹0 bundle only said of the free list", async () => {
    stubRegistry();
    const { site, domainOfferCatalog } = await load();
    const cat = domainOfferCatalog(await site.getSiteTldPrices())!;
    expect(cat.lowPrice).toBe(799);
    expect(cat.highPrice).toBe(1049);
    const offers = cat.offers as { name: string; description: string }[];
    expect(offers.map((o) => o.name.split(" ")[0])).toEqual([".in", ".com"]); // the fixture prices only these
    expect(offers.every((o) => o.description.includes("₹0 for the first year"))).toBe(true); // both in FREE_DOMAIN_TLDS
    expect(cat.offerCount).toBe(2);
  });

  it("registry down later: the last good live price stays, never the placeholder", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-18T10:00:00Z"));
    stubRegistry();
    const { site } = await load();
    expect((await site.getSiteTldPrices()).find((t) => t.tld === ".com")!.reg).toBe(1049);

    registryUp = false;
    vi.setSystemTime(new Date("2026-10-18T10:30:00Z")); // past the 10-minute price cache
    const after = await site.getSiteTldPrices();
    expect(after.find((t) => t.tld === ".com")).toMatchObject({ reg: 1049, renew: 1250, live: true });
    expect(after.find((t) => t.tld === ".in")).toMatchObject({ reg: 799, live: true });
  });

  it("no live price ever: no number anywhere — 'Price at search', no offers, no teaser figure", async () => {
    stubRegistry();
    registryUp = false;
    const { site, rateCard, domainOfferCatalog, domainTeaser } = await load();
    const tlds = await site.getSiteTldPrices();
    expect(tlds.every((t) => t.reg === null && t.renew === null && !t.live)).toBe(true);
    const card = rateCard(tlds);
    expect(card.rows.every((r) => r.cells.length === 1 && r.cells[0] === "Price at search")).toBe(true);
    expect(domainOfferCatalog(tlds)).toBeNull();
    const teaser = domainTeaser(tlds);
    expect(teaser.from).toBeNull();
    expect(teaser.line).not.toMatch(/₹/);
    // None of the old placeholder figures leaks out.
    expect(JSON.stringify(card)).not.toMatch(/₹(499|799|899|1,199)/);
  });
});

describe("R-1599 guard — no public page reads a TLDS placeholder price", () => {
  const root = path.join(__dirname, "../..");
  const files = [
    "app/(marketing)/domains/page.tsx",
    "app/(marketing)/rates/page.tsx",
    "app/(marketing)/page.tsx",
    "app/(marketing)/layout.tsx",
    "site/components/domains/DomainLanding.tsx",
    "site/components/chrome/Header.tsx",
    "site/components/home/HomeV2.tsx",
    "site/components/home/HomeCompany.tsx",
    "site/lib/data/domain-teaser.ts",
    "site/lib/data/copy.ts",
  ];
  it.each(files)("%s does not import TLDS from the catalogue", (f) => {
    const src = readFileSync(path.join(root, f), "utf8");
    expect(src).not.toMatch(/import\s*\{[^}]*\bTLDS\b[^}]*\}\s*from\s*["'][^"']*data\/catalog["']/);
  });
  it("/domains and /rates read getSiteTldPrices", () => {
    for (const f of ["app/(marketing)/domains/page.tsx", "app/(marketing)/rates/page.tsx"]) {
      expect(readFileSync(path.join(root, f), "utf8")).toMatch(/getSiteTldPrices\(\)/);
    }
  });
});
