/**
 * R-1769 (Pawan's report 1b088924, domain half; decision (b), 22 Oct 2026).
 *
 * The owner's path on a laptop: localhost:3001/domains → search "mytestshop" → Add to cart →
 * Checkout → details → tick terms → "Simulate payment" → /done. It stopped at the first step:
 * `npm run dev:local` blanks the ResellerClub keys and the domains-platform address, so
 * /api/domains/availability answered 502 "Could not check availability right now." — and the
 * checkout re-reads the same price (owner decision 19: never sell on a guessed price), so no
 * domain order could ever reach /done locally.
 *
 * Fix: ONLY where a simulated payment is allowed (a laptop — never a deployment, never with a
 * live Razorpay key; lib/checkout/live-guards.ts) and no real price source is configured, the
 * search AND the checkout read one fixed TEST price list, and every such price is marked
 * "TEST price". These tests walk that path through the real route handlers, and prove the
 * list is never used on a deployment or with a live key.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";

const inserts = vi.hoisted(() => ({ rows: [] as { table: string; row: Record<string, unknown> }[] }));
const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
          eq: async () => ({ data: [], error: null }),
        }),
      }),
      insert: async (row: Record<string, unknown>) => {
        inserts.rows.push({ table, row });
        return { error: null };
      },
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
    rpc,
  }),
}));
/* The tenant's own sealed Razorpay keys — null (none) unless a test sets them. */
const tenantKeys = vi.hoisted(() => ({ value: null as null | Record<string, string> }));
vi.mock("@/lib/crypto/tenant-secrets", () => ({ decryptTenantSecrets: () => tenantKeys.value }));
vi.mock("@/lib/marketing/utm", () => ({ captureFromRequest: () => ({}) }));
vi.mock("@/lib/hosting/start-trial", () => ({ startHostingTrial: vi.fn() }));

import { GET as searchGET } from "@/app/api/domains/availability/route";
import { POST as checkoutPOST } from "@/app/api/public/checkout/cart/route";
import { lookupDomains } from "@/lib/domains/live-lookup";
import { TEST_DOMAIN_PRICES, TEST_TAKEN_NAMES, testDomainPricesActive } from "@/lib/domains/test-prices";

type Line = { name: string; qty: number; rate: number; domain?: string; hostingPlan?: string };
const address = { line1: "12 MG Road", city: "New Delhi", state: "Delhi", zipcode: "110001" };
const buyer = { fullName: "Test Buyer", email: "buyer@example.invalid", phone: "9999999999", stateCode: "07", address };
const checkout = (body: Record<string, unknown>) =>
  checkoutPOST(
    new NextRequest("https://example.invalid/api/public/checkout/cart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...buyer, ...body }),
    }),
  );
const search = (name: string) =>
  searchGET(new NextRequest(`https://example.invalid/api/domains/availability?name=${name}&tlds=in,com,co.in,org,net`));
const quote = () => inserts.rows.find((r) => r.table === "quotes")?.row;
const items = () => quote()!.line_items as Line[];
const domainLine = (d: string) => items().find((l) => l.domain === d && !l.hostingPlan);
const dom = (d: string) => ({ sku: `domain:${d.slice(d.indexOf(".") + 1)}`, domain: d, qty: 1 });
const starter = { sku: "hosting:starter", cycle: "yearly", qty: 1 };

/* Every env signal the guards read — cleared before each test so the machine running the
   suite cannot decide the answer. */
const GUARD_ENV = [
  "NODE_ENV", "NEXT_PUBLIC_APP_ENV", "K_SERVICE", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET",
  "NEXT_PUBLIC_RAZORPAY_KEY_ID", "NEXT_PUBLIC_DOMAINS_APP_URL", "BUY_PAGE_TENANT_ID",
];
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const k of GUARD_ENV) vi.stubEnv(k, "");
  vi.stubEnv("NODE_ENV", "test");
  inserts.rows = [];
  tenantKeys.value = null;
  rpc.mockReset().mockImplementation(async (name: string) =>
    name === "next_document_number" ? { data: "Q-TEST-0001", error: null } : { data: null, error: null },
  );
  /* No network: the real platform must never be asked in test mode, and when the list is
     off the platform "is down" so a guessed price could only come from the test list. */
  fetchSpy = vi.fn(async () => { throw new Error("network is off in this test"); });
  vi.stubGlobal("fetch", fetchSpy);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("on a laptop (simulation allowed, no registrar): the TEST price list", () => {
  it("search shows a price for the owner's example 'mytestshop', marked TEST price", async () => {
    const res = await search("mytestshop");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; domains: { domain: string; available: boolean; price: number; priceKnown: boolean; testPrice?: boolean }[] };
    expect(body.source).toBe("test");
    const com = body.domains.find((d) => d.domain === "mytestshop.com")!;
    expect(com).toMatchObject({ available: true, priceKnown: true, price: TEST_DOMAIN_PRICES.com, testPrice: true });
    expect(body.domains.map((d) => d.domain)).toEqual(["mytestshop.in", "mytestshop.com", "mytestshop.co.in", "mytestshop.org", "mytestshop.net"]);
    expect(body.domains.every((d) => d.testPrice === true)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a reserved name comes back TAKEN, so the taken path can be tested too", async () => {
    const res = await search(TEST_TAKEN_NAMES[0]);
    const body = (await res.json()) as { domains: { available: boolean; priceKnown: boolean }[] };
    expect(body.domains.length).toBeGreaterThan(0);
    expect(body.domains.every((d) => !d.available && !d.priceKnown)).toBe(true);
  });

  it("domain only: cart → checkout → Simulate payment is recorded (the page then opens /done)", async () => {
    const res = await checkout({ simulate: true, domain: "mytestshop.com", lines: [dom("mytestshop.com")] });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success?: boolean; simulated?: boolean; quoteId?: string };
    expect(json).toMatchObject({ success: true, simulated: true });
    // Charged the SAME test price the search showed, and the line says it is a test price.
    expect(domainLine("mytestshop.com")!.rate).toBe(TEST_DOMAIN_PRICES.com);
    expect(domainLine("mytestshop.com")!.name).toMatch(/TEST price/);
    expect(quote()!.amount).toBe(Math.round(TEST_DOMAIN_PRICES.com * 1.18));
    expect(rpc).toHaveBeenCalledWith("record_payment", expect.anything());
  });

  it("hosting + domain together: yearly Starter makes the .in free, the order is recorded", async () => {
    const res = await checkout({ simulate: true, domain: "mytestshop.in", lines: [starter, dom("mytestshop.in")] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { simulated?: boolean }).simulated).toBe(true);
    expect(domainLine("mytestshop.in")!.rate).toBe(0);
    expect(quote()!.amount).toBe(708); // Starter ₹600 + GST, the same as R-1595's bundle
  });

  it("a 2-year term is priced from the list's own 2-year total", async () => {
    const res = await checkout({ simulate: true, domain: "mytestshop.org", lines: [{ ...dom("mytestshop.org"), years: 2 }] });
    expect(res.status).toBe(200);
    expect(domainLine("mytestshop.org")!.rate).toBe(TEST_DOMAIN_PRICES.org * 2);
  });

  it("a reserved (taken) name cannot be bought", async () => {
    const d = `${TEST_TAKEN_NAMES[0]}.com`;
    const res = await checkout({ simulate: true, domain: d, lines: [dom(d)] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/no longer available/);
  });
});

describe("NEVER on a deployment or with a live key — the test list is off", () => {
  const deployed: [string, Record<string, string>][] = [
    ["NODE_ENV=production (every deployed image)", { NODE_ENV: "production" }],
    ["NEXT_PUBLIC_APP_ENV=staging", { NEXT_PUBLIC_APP_ENV: "staging" }],
    ["NEXT_PUBLIC_APP_ENV=production", { NEXT_PUBLIC_APP_ENV: "production" }],
    ["Cloud Run (K_SERVICE)", { K_SERVICE: "anutech-app" }],
    ["a live Razorpay key in env", { RAZORPAY_KEY_ID: "rzp_live_abc", RAZORPAY_KEY_SECRET: "x" }],
    ["a live Razorpay public key id", { NEXT_PUBLIC_RAZORPAY_KEY_ID: "rzp_live_abc" }],
    ["a real domains platform configured", { NEXT_PUBLIC_DOMAINS_APP_URL: "http://localhost:4310" }],
  ];
  it.each(deployed)("%s → not active", (_label, env) => {
    expect(testDomainPricesActive({ rcConfigured: false, env: { NODE_ENV: "test", ...env } })).toBe(false);
  });
  it("a registrar configured on this server → not active", () => {
    expect(testDomainPricesActive({ rcConfigured: true, env: { NODE_ENV: "test" } })).toBe(false);
  });
  it("a plain laptop → active (the control for the rows above)", () => {
    expect(testDomainPricesActive({ rcConfigured: false, env: { NODE_ENV: "development" } })).toBe(true);
  });

  it.each(deployed.filter(([l]) => !/domains platform/.test(l)))("%s → search asks the real platform and fails honest (502), no test price", async (_l, env) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const res = await search("mytestshop");
    expect(res.status).toBe(502);
    expect(fetchSpy).toHaveBeenCalled();
    const out = await lookupDomains("mytestshop", ["com"]);
    expect(out.ok).toBe(false);
  });

  it("on a deployment the checkout cannot sell a domain at a test price", async () => {
    vi.stubEnv("K_SERVICE", "anutech-app");
    vi.stubEnv("BUY_PAGE_TENANT_ID", "fbb0aaaa-0000-4000-8000-000000000001");
    const res = await checkout({ simulate: true, domain: "mytestshop.com", lines: [dom("mytestshop.com")] });
    expect(res.status).not.toBe(200);
    expect(rpc).not.toHaveBeenCalledWith("record_payment", expect.anything());
  });

  it("a live Razorpay key stored on the tenant (not in env) → the test-priced order is refused", async () => {
    tenantKeys.value = { razorpay_key_id: "rzp_live_abc", razorpay_key_secret: "s", razorpay_mode: "live" };
    const res = await checkout({ domain: "mytestshop.com", lines: [dom("mytestshop.com")] });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/TEST price/);
    expect(inserts.rows.find((r) => r.table === "quotes")).toBeUndefined();
    expect(rpc).not.toHaveBeenCalledWith("record_payment", expect.anything());
  });
});

describe("every screen that shows a test-list price says TEST price", () => {

  const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const landing = code("src/site/components/domains/DomainLanding.tsx");
  const hero = code("src/site/components/home/DomainSearch.tsx");
  const offer = code("src/site/components/domains/domain-offer.ts");
  it("the label is one shared constant", async () => {
    const { TEST_PRICE_LABEL } = await import("@/site/lib/domain-search");
    expect(TEST_PRICE_LABEL).toBe("TEST price");
  });
  it("/domains: the result block shows the TEST price note for a test-list answer (available and taken)", () => {
    expect(landing.match(/\{primary\.testPrice && <TestPriceNote /g)).toHaveLength(2);
    expect(landing).toMatch(/function TestPriceNote[\s\S]*\{TEST_PRICE_LABEL\}/);
  });
  it("/domains and the home search put TEST price on the cart line, so cart and checkout show it", () => {
    // R-1772: /domains builds its cart lines in one helper (also the shown total).
    expect(landing).toMatch(/domainOffer\(\{[\s\S]*testPrice: primary\?\.testPrice/);
    expect(offer).toMatch(/detail: p\.testPrice \? `\$\{TEST_PRICE_LABEL\} · /);
    expect(hero).toMatch(/detail: r\.testPrice \? `\$\{TEST_PRICE_LABEL\} · /);
  });
  it("the home search shows TEST price next to the price", () => {
    expect(hero).toMatch(/\{r\.testPrice && <span[^>]*>\{TEST_PRICE_LABEL\}<\/span>\}/);
  });
});
